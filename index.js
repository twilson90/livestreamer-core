const pm2 = require("pm2");
const path = require("node:path");
const fs = require("fs-extra");
const events = require("node:events");
const readline = require("node:readline");
const cron = require("node-cron");
const os = require("node:os");
const {glob} = require("glob");

const IS_WINDOWS = (process.platform === "win32");
const IS_MASTER = require.main === module;
var rid = 0;

var [inspect_hostname, inspect_port] = (()=>{
    var inspect_arg = process.argv.find(a=>a.match(/^--inspect(-)?/)) || "";
    var inspect_hostname = "127.0.0.1";
    var inspect_port = "9229";
    var inspect_host = inspect_arg.split("=")[1] || `${inspect_hostname}:${inspect_port}`;
    if (inspect_host.match(/^[^:]+:\d+$/)) [inspect_hostname, inspect_port] = inspect_host.split(":");
    else inspect_hostname = inspect_host || inspect_hostname;
    return [inspect_hostname, inspect_port]
})();

/** @type {cron.ScheduledTask} */
var compress_logs_cron;

const core = module.exports = new class extends events.EventEmitter {
    /** @type {import("./config.default.js")} */
    conf = {};
    apps = {};
    /** @type {Record<string,Process>} */
    processes = {};
    /** @type {import("./lib/App")} */
    app = null;
    IS_MASTER = IS_MASTER;
    pid = process.pid;
    ppid = process.ppid;
    /** @type {App} */
    app;
    /** @type {Logger} */
    logger;
    #initialized;
    
    init() {
        if (this.#initialized) return;

        this.#initialized = true;
        this.pkg = require("./package.json");

        process.chdir(__dirname);
        
        this.root_dir = path.resolve(__dirname);
        this.lib_dir = path.join(this.root_dir, "lib");
        for (var f of fs.readdirSync(this.lib_dir, {withFileTypes:true})) {
            var index_file = path.resolve(this.lib_dir, f.name, "index.js");
            if (f.isDirectory() && fs.existsSync(index_file)) {
                this.apps[f.name] = index_file;
            }
        }

        var config_loader = new ConfigLoader();

        this.#load_conf(config_loader.load());
        
        if (IS_MASTER) {
            config_loader.watch((conf)=>{
                console.info("Conf was updated.");
                this.#load_conf(conf);
                this.ipc_send("*", "update_conf", this.conf);
            });
        }

        this.logger = new Logger(this.app.name, {stdout:true, file:true});
        this.logger.console_adapter();
        
        if (IS_MASTER) {
            fs.mkdirSync(this.appdata_dir, { recursive: true });
            fs.mkdirSync(this.bin_dir, { recursive: true });
            fs.mkdirSync(this.tmp_dir, { recursive: true });
            fs.mkdirSync(this.logs_dir, { recursive: true });
            fs.mkdirSync(this.cache_dir, { recursive: true });
            fs.mkdirSync(this.clients_dir, {recursive:true});

            let appdata_shortcut = path.join(this.root_dir, ".appdata");
            fs.removeSync(appdata_shortcut);
            fs.symlinkSync(this.appdata_dir, appdata_shortcut, "junction");
        }
        
        this.has_root_privileges = utils.has_root_privileges();
        this.logger.info(`Starting ${this.app.name}...`);
        this.logger.info(`  cwd: ${process.cwd()}`);
        this.logger.info(`  appdata: ${this.appdata_dir}`);
        this.has_root_privileges ? this.logger.info(`  has_root_privileges: true`) : this.logger.warn(`  has_root_privileges: false (Without root privileges some functionality will be limited.)`);
        
        // is this a good idea?
        process.on('unhandledRejection', (e) => {
            this.logger.error(`Unhandled Rejection`, e);
        });

        if (!process.env.PATH.startsWith(this.bin_dir + path.delimiter)) {
            process.env.PATH = this.bin_dir + path.delimiter + process.env.PATH;
        }

        this.stdin_listener = readline.createInterface(process.stdin);
        this.stdin_listener.on("line", (line)=>{
            var parts = utils.split_spaces_exclude_quotes(line);
            this.emit("input", parts);
        });

        this.proxy_socket_path = this.#get_app_socket_path(this.app.name);
        
        if (IS_MASTER) {

            if (!IS_WINDOWS) {
                for (var s of (glob.sync(`/tmp/${this.conf["appspace"]}-*`))) {
                    try { fs.rmSync(s) } catch { console.log(`Could not delete ${s}`); }
                }
            }
            // await fs.mkdir(this.credentials_dir, { recursive: true });
            
            this.#setup_proxies();
            this.#compress_logs();

        } else {

            console.log(`'${this.app.name}' LISTENING`);
            
            process.on('message', (msg)=>{
                if (msg === "shutdown") {
                    this.#destroy();
                } else if (msg.type === "process:msg") {
                    var d = msg.data;
                    if (d.event === "update_conf") {
                        this.conf = d.data;
                    } else if (d.event === "request") {
                        var {rid, requestee, request} = d.data;
                        new Promise((resolve,reject)=>{
                            var result;
                            if (request.call !== undefined) result = utils.call(this.app, request.call, request.arguments);
                            else if (request.get !== undefined) result = utils.get(this.app, request.get);
                            else if (request.set !== undefined) result = utils.set(this.app, request.set, request.value);
                            else {
                                reject(`Invalid request: ${JSON.stringify(request)}`);
                                return;
                            }
                            Promise.resolve(result).then(resolve).catch(reject);
                        })
                        .then((result)=>[result, null])
                        .catch((err)=>[null, err])
                        .then(([result,err])=>{
                            this.ipc_send(requestee, `request.${rid}`, [result, err]);
                        });
                    }
                    this.emit(d.event, d.data);
                }
            });
        }
        this.#connect();
    }
    
    // $ = new utils.Observer({});

    /** @param {App} app */
    async register(app) {
        this.app = app;
        await this.init();
        setTimeout(()=>app.init(), 0);
        process.on("SIGINT", ()=>this.#destroy());
    }

    async #connect() {
        // if dameon is already running under a different user, and this script does not have privileges... it will fuck up.
        await new Promise((resolve,reject)=>{
            var nodaemon = IS_WINDOWS;
            pm2.connect(nodaemon, async (err)=>{
                if (err) reject(err);
                else resolve();
            });
        });

        this.init_promise = new Promise((resolve)=>{
            pm2.list((err,procs)=>{
                procs = procs.map(p=>parse_process(p)).filter(p=>p.appspace === this.conf["appspace"]);
                for (var p of procs) {
                    this.processes[p.name] = p
                    if (p.name !== this.app.name) {
                        this.emit(`${p.name}.connected`);
                    }
                }
                this.emit("init");
                if (procs.length) this.emit("update_processes");
                resolve();
            })
        });

        pm2.launchBus((err, bus)=>{
            // a process has changed or started
            bus.on('process:event', (data)=>{
                var event = data.event;
                var pm_id = data.process.pm_id;
                pm2.describe(pm_id, (err, pd)=>{
                    if (!pd[0]) return;
                    var p = parse_process(pd[0]);
                    if (p.appspace !== this.conf["appspace"]) return;
                    this.processes[p.name] = p;
                    if (data.event === "exit") {
                        this.emit(`${p.name}.disconnected`);
                    }
                    this.emit("update_processes");
                });
            });
            if (IS_MASTER) {
                bus.on('process:msg', (d)=>{
                    if (d.data[0] === "pm2") {
                        this[`pm2_${d.data[1]}`](...d.data.slice(2));
                    }
                    // only master can receive messages from child processes with this...
                });
            }
        });

        await this.init_promise;
        
        if (IS_MASTER) {
            for (var m of this.conf["modules"]) {
                if (this.conf[`${m}.autostart`] != false) {
                    var p = this.processes[m];
                    if (m === "electron") continue;
                    if (!p || p.status === "stopped") {
                        this.pm2_start(m);
                    } else {
                        this.pm2_restart(m);
                    }
                }
            }
        } else {
            this.ipc_send("*", `${this.app.name}.connected`);
        }
    }

    async pm2_start(m) {
        if (IS_MASTER) {
            var i = Object.keys(this.apps).indexOf(m)+1;
            /** @type {pm2.StartOptions} */
            var p = {
                // "max_restarts": 5,
                "name": `${this.conf["appspace"]}.${m}`,
                "script": path.resolve(this.lib_dir, m, "index.js"),
                "cwd": __dirname,
                "autorestart": true,
                "restart_delay": 5000,
                "node_args": [],
                // "cron_restart" : null // prevent inheriting
            };
            if (process.env.LIVESTREAMER_DEBUG) {
                p.node_args.push(`--inspect=${inspect_hostname}:${+inspect_port+i}`);
                // console.log(p.node_args);
            }
            return new Promise((resolve)=>{
                pm2.start(p, (err, procs)=>{
                    if (err) console.error("pm2.start", err);
                    resolve();
                });
            });
        } else {
            process.send({
                type: "process:msg",
                data: ["pm2", "start", m]
            });
        }
    }

    async pm2_restart(m) {
        if (IS_MASTER) {
            return new Promise((resolve)=>{
                pm2.restart(`${this.conf["appspace"]}.${m}`, (err, proc)=>{
                    if (err) console.error("pm2.restart", err);
                    resolve();
                });
            });
        } else {
            process.send({
                type: "process:msg",
                data: ["pm2", "restart", m]
            });
        }
    }

    async pm2_stop(m) {
        if (IS_MASTER) {
            return new Promise((resolve)=>{
                pm2.stop(`${this.conf["appspace"]}.${m}`, (err, proc)=>{
                    if (err) console.error("pm2.stop", err);
                    resolve();
                });
            });
        } else {
            process.send({
                type: "process:msg",
                data: ["pm2", "stop", m]
            });
        }
    }
    
    async ipc_send(name, event, data) {
        await this.init_promise;
        /** @type {Process[]} */
        var processes;
        if (name == "*") {
            processes = Object.values(Object.entries(this.processes).filter(([k,v])=>k!==this.app.name))
        } else {
            processes = [this.processes[name]]
        }
        return Promise.all(processes.map(p=>{
            if (p.status === "stopped") return;
            return new Promise((resolve,reject)=>{
                pm2.sendDataToProcessId({
                    "type": 'process:msg',
                    "topic": 1,
                    "data": { event, data },
                    "id": p.pm_id,
                }, (err, res) => {
                    if (err) {
                        console.error("ipc", err);
                    } else {
                        resolve(res);
                    }
                })
            })
        }));
    }

    async ipc_request(name, request, timeout=10000) {
        var p = this.processes[name];
        if (!p) return;
        return utils.promise_timeout(new Promise((resolve,reject)=>{
            this.ipc_send(name, "request", { rid: ++rid, requestee: this.app.name, request })
            this.once(`request.${rid}`, ([result,err])=>{
                if (err) reject(err);
                else resolve(result);
            });
        }), timeout).catch(e=>{
            if (e instanceof utils.TimeoutError) console.warn(`request timed out: ${name} ${JSON.stringify(request)}`);
            else throw e;
        });
    }
    
    #get_app_socket_path(name) {
        return this.socket_path(`${this.conf["appspace"]}.${name}`);
    }

    socket_path(sock_name) {
        return IS_WINDOWS ? `\\\\.\\pipe\\${sock_name}` : `/tmp/${this.conf["appspace"]}-${sock_name}.sock`;
    }
    
    #setup_proxies() {
        const http = require("node:http");
        const https = require("node:https");
        const http_proxy  = require("http-proxy");
        const agent = new http.Agent({
            maxSockets: Number.MAX_SAFE_INTEGER,
            keepAlive: true,
            keepAliveMsecs: 30 * 1000
        });
        const proxies = {};
        /** @param {http.IncomingMessage} req @param {string} name */
        var get_proxy = (req)=>{
            var url = new URL(req.url, "http://localhost");
            var parts = url.pathname.slice(1).split("/");
            var name = parts[0];
            var proxy, target;
            // for some reason this adds a big delay to any request... can't figure it out
            if (this.processes[name] && this.processes[name].status === "online") {
                req.url = "/"+parts.slice(1).join("/") + url.search;
                if (!proxies[name]) {
                    proxies[name] = http_proxy.createProxy({ agent });
                    proxies[name].on("error", (e)=>{
                        console.warn(e);
                    })
                }
                proxy = proxies[name];
                target = { socketPath: this.#get_app_socket_path(name) };
            }
            return { proxy, target };
        }

        /** @type {(req: http.IncomingMessage, socket: import("stream").Duplex, head: Buffer) => void} */
        const handle_upgrade = (req, socket, head)=>{
            var { proxy, target } = get_proxy(req);
            if (!proxy) {
                socket.end();
                return;
            }
            proxy.ws(req, socket, head, {
                xfwd: true,
                target
            });
        };
        
        // const exp = express();
        // exp.use("/node_modules", require("compression")({threshold:0}), express.static(path.resolve(this.root_dir, "node_modules")));
        // exp.use();

        console.info(`Starting HTTP Server on port ${this.conf["http_port"]}`);
        let proxy_http_server = http.createServer((req, res)=>{
            // if (http and https is available) {
            //   res.redirect("https://" + req.headers.host + req.path);
            // }
            var { proxy, target } = get_proxy(req);
            if (proxy) {
                proxy.web(req, res, {
                    xfwd: true,
                    target
                });
            } else {
                res.statusCode = 500;
                res.end();
            }
        });
        proxy_http_server.listen(this.conf["http_port"]);
        proxy_http_server.on('upgrade', handle_upgrade);
        
        let servers = [proxy_http_server];
        var certs = this.#get_certs();
        if (this.conf["https_port"] && certs) {
            console.info(`Starting HTTPS Server on port ${this.conf["https_port"]}`);
            let proxy_https_server = https.createServer(certs, exp);
            proxy_https_server.listen(this.conf["https_port"]);
            proxy_https_server.on('upgrade', handle_upgrade);
            servers.push(proxy_https_server);
            
            setInterval(()=>{
                var certs = this.#get_certs();
                if (certs) proxy_https_server.setSecureContext(certs);
            }, 1000*60*60*24*7) // every week
        }

        for (var s of servers) {
            s.keepAliveTimeout = (60 * 1000);
            s.headersTimeout = (60 * 1000);
        }
    }

    #get_certs(){
        try { return { key: fs.readFileSync(this.conf["ssl_key"]), cert: fs.readFileSync(this.conf["ssl_cert"]) }; } catch {}
    }

    #setup_cron_jobs() {
        if (compress_logs_cron) compress_logs_cron.stop();
        compress_logs_cron = cron.schedule(this.conf["compress_logs_schedule"], ()=>this.#compress_logs());
    }

    #compress_logs() {
        utils.compress_logs_directory(this.logs_dir);
        this.ipc_send("*", "compress_logs");
    }

    #load_conf(conf) {
        this.conf = conf;

        this.appdata_dir = path.resolve(this.conf["appdata_dir"]);
        this.bin_dir = path.resolve(this.appdata_dir, "bin");
        this.tmp_dir = path.resolve(this.appdata_dir, "tmp");
        this.logs_dir = path.resolve(this.appdata_dir, "logs");
        this.cache_dir = path.resolve(this.appdata_dir, "cache");
        this.clients_dir = path.resolve(this.appdata_dir, "clients");

        this.use_https = !!(this.conf["https_port"] && this.#get_certs());
        this.host = `${this.conf["hostname"]}:${this.conf["http_port"]}`;
        this.http_url = `http://${this.host}`;
        this.https_url = `https://${this.host}`;
        this.url = this.use_https ? this.https_url : this.http_url;
        if (IS_MASTER) {
            // fs.writeFileSync(path.join(this.appdata_dir, "last_config.json"), JSON.stringify(this.conf, null, "  "));
            this.#setup_cron_jobs();
        }
    }

    authorise(req, res) {
        if (this.conf["authenticator"]) {
            var auth;
            try {
                auth = require(path.resolve(this.conf["authenticator"]));
                return auth.login(req, res);
            } catch (e) {
                console.error("authorise error", e);
            }
        } else {
            return { name: "admin" }
        }
    }

    async #destroy() {
        console.info("Handling shutdown...");
        await this.app.destroy();
        process.exit(0);
    }

    set_priority(pid, pri) {
        try {
            if (pid) os.setPriority(pid, pri);
            else os.setPriority(pri);
        } catch (e) {
            this.logger.warn(`Could not set process priority for pid: ${pid||process.pid}`);
        }
    }
}

/** @param {string} name */
function parse_process_name(name) {
    var [appspace, name] = name.split(/\.(.*)/);
    return {appspace, name};
}
/** @typedef {{appspace, name, fullname, status, pm_id, pid}} Process */
/** @param {pm2.ProcessDescription} p @returns {Process} */
function parse_process(p) {
    var {appspace, name} = parse_process_name(p.name);
    var data = {
        appspace,
        name,
        fullname: p.name,
        status: p.pm2_env.status,
        pm_id: p.pm_id,
        pid: p.pid
    }
    return data;
}

const utils = require("./utils");
const Logger = require("./Logger");
const App = require("./App");
const ConfigLoader = require("./ConfigLoader.js");

if (IS_MASTER) {
    core.register(new class extends App {
        constructor() { super("root"); }
        async init() { }
        async destroy() { }
        // async destroy() {
        //     var processes = Object.values(core.processes).filter(p=>p.name !== core.app.name);
        //     return Promise.all(processes.map(p=>core.pm2_stop(p.name)));
        // }
    });
}
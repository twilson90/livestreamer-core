import pm2 from "pm2";
import path from "node:path";
import fs from "fs-extra";
import events from "node:events";
import readline from "node:readline";
import net from "node:net";
import cron from "node-cron";
import os from "node:os";
import { glob } from "glob";
import http_proxy from "http-proxy";
import http from "node:http";
import https from "node:https";
import { ConfigLoader, Logger, utils } from "./internal.js";
// import pkg from "./package.json" with { type: "json" };
const __dirname = import.meta.dirname;
var rid = 0;

const core = new class extends events.EventEmitter {
    /** @type {typeof import("./config.default.js").default & typeof import("../file-manager/config.default.js").default & typeof import("../media-server/config.default.js").default & typeof import("../main/config.default.js").default} */
    conf = {};
    // just a map of name:path to dir
    modules = {};
    /** @type {Record<string,Process>} */
    processes = {};
    pid = process.pid;
    ppid = process.ppid;
    /** @type {Logger} */
    logger;
    #initialized;
    #app;
    #auth;
    #IS_MASTER;
    #pm2_process;
    /** @type {cron.ScheduledTask} */
    #compress_logs_cron;
    #init_promise;
    root_socket_path
    
    get portable() { return !!(process.env.LIVESTREAMER_PORTABLE ?? this.conf["core.portable"]) ?? false };
    get debug() { return !!(process.env.LIVESTREAMER_DEBUG ?? this.conf["core.debug"]) ?? false; }
    
    async init(name, app) {
        if (this.#initialized) return;
        
        this.#IS_MASTER = (name === "root");
        this.appspace = process.env.LIVESTREAMER_APPSPACE || "livestreamer";

        this.cwd = process.cwd();
        this.name = name;
        this.#app = app;
        this.logger = new Logger(this.name, {stdout:true, file:true});
        this.logger.console_adapter();
        
        this.#initialized = true;
        var exit_handler = async ()=>{
            console.log("SIGINT");
            await this.#destroy();
            process.exit(0);
        }
        process.on('SIGINT', exit_handler);
        process.on('SIGTERM', exit_handler);

        await this.#cleanup_sockets();

        this.ipc_socket_path = this.get_socket_path(`${this.name}_ipc`)
        this.http_socket_path = this.get_socket_path(`${this.name}_http`);

        this.ipc_server = net.createServer((stream)=>{
            stream.on('end', function() {
            });
            stream.on('data', function(msg) {
            });
        }).listen(this.ipc_socket_path);

        if (this.#IS_MASTER) {

            let config_loader = new ConfigLoader();
            await this.#load_conf(await config_loader.load());
            config_loader.watch(async (conf)=>{
                console.info("Conf was updated.");
                await this.#load_conf(conf);
            });
        } else {
            await this.#init_appdata();
            await this.#load_conf(JSON.parse(await fs.readFile(this.conf_path, "utf-8")));
            this.on("core.update-conf", async (conf)=>{
                this.#load_conf(conf);
            });
        }
        
        this.logger.info(`Starting ${this.name}...`);
        this.logger.info(`  cwd: ${this.cwd}`);
        this.logger.info(`  module: ${__dirname}`);
        this.logger.info(`  appdata: ${this.appdata_dir}`);
        if (utils.has_root_privileges()) {
            this.logger.info(`  root: true`);
        } else {
            this.logger.warn(`  root: false (Without root privileges some functionality will be limited.)`);
        }
        
        // is this a good idea?
        process.on('unhandledRejection', (e) => {
            this.logger.error(`Unhandled Rejection:`, e);
        });

        this.stdin_listener = readline.createInterface(process.stdin);
        this.stdin_listener.on("line", (line)=>{
            var parts = utils.split_spaces_exclude_quotes(line);
            this.emit("input", parts);
        });

        if (this.#IS_MASTER) {
            await this.#setup_proxies();
            await this.#compress_logs();
            this.#compress_logs_cron = cron.schedule(this.conf["core.compress_logs_schedule"], ()=>this.#compress_logs());
        } else {
            console.log(`'${this.name}' LISTENING`);
        }
        
        process.on('message', async (packet)=>{
            if (typeof packet === "string") {
                if (packet === "shutdown") {
                    await this.#destroy();
                }
            } else if (packet.type === "process:msg") {
                var d = packet.data;
                if (d.event) {
                    var {data, event, origin} = d;
                    if (origin === this.name) return;
                    if (event === "request") {
                        this.#on_ipc_request(data);
                    } else if (event === "module_start") {
                        this.module_start(...data);
                    } else if (event === "module_stop") {
                        this.module_stop(...data);
                    } else if (event === "module_restart") {
                        this.module_restart(...data);
                    }
                    if (event) this.emit(event, data);
                }
                if (this.#IS_MASTER) {
                    this[event].apply(this, data);
                }
            }
        });

        if (process.env.pm_id) {
            this.#pm2_process = await new Promise(resolve=>{
                pm2.describe(process.env.pm_id, (err, pd)=>{
                    resolve(pd[0]);
                })
            });
        }

        pm2.launchBus((err, bus)=> {
            console.log(this.name);
            // a process has changed or started
            bus.on('process:event', (packet)=>{
                var event = packet.event;
                var pm_id = packet.process.pm_id;
                pm2.describe(pm_id, (err, pd)=>{
                    if (!pd[0]) return;
                    var p = parse_process(pd[0]);
                    if (p.appspace !== this.appspace) return;
                    this.processes[p.name] = p;
                    if (event === "exit") {
                        this.emit(`${p.name}.disconnected`);
                    }
                    this.emit("core.update-processes");
                });
            });
            // bus.on('process:msg', (packet)=>{
            //     // all pm2 processes see these :/
            // });
        });

        this.#init_promise = (async()=>{
            // if dameon is already running under a different user, and this script does not have privileges... it will fuck up.
            await new Promise((resolve,reject)=>{
                var nodaemon = utils.is_windows();
                pm2.connect(nodaemon, async (err)=>{
                    if (err) reject(err);
                    else resolve();
                });
            });
            await new Promise((resolve)=>{
                pm2.list((err,procs)=>{
                    procs = procs.map(p=>parse_process(p)).filter(p=>p.appspace === this.appspace);
                    for (var p of procs) {
                        this.processes[p.name] = p
                        if (p.name !== this.name) {
                            this.emit(`${p.name}.connected`);
                        }
                    }
                    this.emit("init");
                    if (procs.length) this.emit("core.update-processes");
                    resolve();
                })
            })
        })();

        await this.#init_promise;
        
        this.#update_modules();
        if (!this.#IS_MASTER) {
            this.ipc_broadcast(`${this.name}.connected`);
        }

        if (this.#app && this.#app.init) await this.#app.init();
    }

    #update_modules() {
        let old_modules = {...this.modules};
        this.modules = {};
        for (let module_path of this.conf["core.modules"]) {
            module_path = path.resolve(module_path);
            let m = path.basename(module_path);
            this.modules[m] = module_path;
        }
        if (this.#IS_MASTER) {
            for (let m of Object.keys(this.modules)) {
                let p = this.processes[m];
                if (!p || p.status === "stopped") {
                    this.module_start(m);
                }
            }
            for (let m in old_modules) {
                if (this.modules[m]) continue;
                let p = this.processes[m];
                if (p && p.status === "online") {
                    this.module_stop(m);
                }
            }
        }
    }

    async module_start(m) {
        if (this.#IS_MASTER) {
            /** @type {pm2.StartOptions} */
            var p = {
                // "max_restarts": 5,
                "name": `${this.appspace}.${m}`,
                "script": path.resolve(this.modules[m], "index.js"),
                "autorestart": true,
                "restart_delay": 5000,
                "node_args": [],
                // "cron_restart" : null // prevent inheriting
            };
            if (this.debug) {
                var i = Object.keys(this.modules).indexOf(m)+1;
                var [inspect_hostname, inspect_port] = this.#get_inspect();
                let inspect = `${inspect_hostname}:${+inspect_port+i}`;
                if (this.conf[`${m}.inspect`]) inspect = this.conf[`${m}.inspect`];
                p.node_args.push(`--inspect=${inspect}`);
                p.node_args.push(`--title="A\\,RsE"`);
                // console.log(p.node_args);
            }
            return new Promise((resolve)=>{
                pm2.start(p, (err, procs)=>{
                    if (err) console.error("pm2.start", err);
                    resolve();
                });
            });
        } else {
            ipc_root("module_start", [m]);
        }
    }

    async module_restart(m) {
        if (this.#IS_MASTER) {
            return new Promise((resolve)=>{
                pm2.restart(`${this.appspace}.${m}`, (err, proc)=>{
                    if (err) console.error("pm2.restart", err);
                    resolve();
                });
            });
        } else {
            ipc_root("module_restart", [m]);
        }
    }

    async module_stop(m) {
        if (this.#IS_MASTER) {
            return new Promise((resolve)=>{
                pm2.stop(`${this.appspace}.${m}`, (err, proc)=>{
                    if (err) console.error("pm2.stop", err);
                    resolve();
                });
            });
        } else {
            ipc_root("module_stop", [m]);
        }
    }
    
    async ipc_root(event, data) {
        process.send({
            type: "process:msg",
            data: { event, data }
        });
    }
    
    async ipc_broadcast(event, data) {
        await this.#init_promise;
        if (this.#IS_MASTER) {
            var process_names = Object.keys(this.processes).filter(k=>k!==this.name);
            for (var p of process_names) {
                await ipc_send(p, event, data);
            }
        } else {
            process.send({
                type: "process:msg",
                data: { event, data, origin:this.name }
            });
        }
    }
    
    async ipc_send(name, event, data) {
        await this.#init_promise;
        var p = this.processes[name];
        if (p.status === "stopped") return;
        pm2.sendDataToProcessId({
            "type": 'process:msg',
            "topic": 1,
            "data": { event, data, origin: this.name },
            "id": p.pm_id,
        }, (err, res) => {
            if (err) console.error("ipc", err);
        });
    }

    async ipc_request(name, request, timeout=10000) {
        var p = this.processes[name];
        if (!p) return;
        return new Promise((resolve,reject)=>{
            this.ipc_send(name, "request", { rid: ++rid, requestee: this.name, request })
            this.once(`request.${rid}`, ([result,err])=>{
                if (err) reject(err);
                else resolve(result);
            });
            setTimeout(()=>reject(`ipc_request timed out: ${name} ${JSON.stringify(request)}`), timeout);
        }).catch((e)=>this.logger.error(e));
    }

    async #on_ipc_request(data) {
        var {rid, requestee, request} = data;
        return new Promise((resolve,reject)=>{
            var result;
            if (request.call !== undefined) result = utils.call(this.#app, request.call, request.arguments);
            else if (request.get !== undefined) result = utils.get(this.#app, request.get);
            else if (request.set !== undefined) result = utils.set(this.#app, request.set, request.value);
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

    get_socket_path(sock_name) {
        return utils.is_windows() ? `\\\\.\\pipe\\${this.appspace}_${sock_name}` : `/tmp/${this.appspace}_${sock_name}.sock`;
    }

    async #cleanup_sockets() {
        if (utils.is_windows()) return;
        if (!this.#IS_MASTER) return;
        console.info("Cleaning up sockets")
        for (var s of (glob.sync(`/tmp/${this.appspace}_*.sock`))) {
            try {
                fs.rmSync(s)
                console.info(`Removed '${s}'`)
            } catch {
                console.log(`Could not delete '${s}'`);
            }
        }
    }
    
    async #setup_proxies() {
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
                target = { socketPath: this.get_socket_path(`${name}_http`) };
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

        console.info(`Starting HTTP Server on port ${this.conf["core.http_port"]}`);
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
        proxy_http_server.listen(this.conf["core.http_port"]);
        proxy_http_server.on('upgrade', handle_upgrade);
        
        let servers = [proxy_http_server];
        var certs = await this.#get_certs();
        if (this.conf["core.https_port"] && certs) {
            console.info(`Starting HTTPS Server on port ${this.conf["core.https_port"]}`);
            let proxy_https_server = https.createServer(certs, exp);
            proxy_https_server.listen(this.conf["core.https_port"]);
            proxy_https_server.on('upgrade', handle_upgrade);
            servers.push(proxy_https_server);
            
            setInterval(async ()=>{
                var certs = await this.#get_certs();
                if (certs) proxy_https_server.setSecureContext(certs);
            }, 1000*60*60*24*7) // every week
        }

        for (var s of servers) {
            s.keepAliveTimeout = (60 * 1000);
            s.headersTimeout = (60 * 1000);
        }
    }

    async #get_certs(){
        try { return { key: await fs.readFile(this.conf["core.ssl_key"]), cert: await fs.readFile(this.conf["core.ssl_cert"]) }; } catch {}
    }

    async #compress_logs() {
        await utils.compress_logs_directory(this.logs_dir);
        this.ipc_broadcast("compress_logs");
    }

    async #init_appdata() {
        var appdata_dir;
        if (process.env.LIVESTREAMER_APPDATA_DIR) {
            appdata_dir = path.resolve(process.env.LIVESTREAMER_APPDATA_DIR);
        } else if (this.portable) {
            appdata_dir = path.resolve(".appdata");
        } else if (utils.is_windows()) {
            appdata_dir = path.resolve(process.env.PROGRAMDATA, this.appspace);
        } else {
            appdata_dir = path.resolve("/var/opt/", this.appspace);
        }
        this.appdata_dir = process.env.LIVESTREAMER_APPDATA_DIR = appdata_dir;
        this.tmp_dir = path.resolve(this.appdata_dir, "tmp");
        this.logs_dir = path.resolve(this.appdata_dir, "logs");
        this.cache_dir = path.resolve(this.appdata_dir, "cache");
        this.clients_dir = path.resolve(this.appdata_dir, "clients");
        this.conf_path = path.resolve(this.appdata_dir, "config.json");
        await fs.mkdir(this.appdata_dir, { recursive: true });
        await fs.mkdir(this.tmp_dir, { recursive: true });
        await fs.mkdir(this.logs_dir, { recursive: true });
        await fs.mkdir(this.cache_dir, { recursive: true });
        await fs.mkdir(this.clients_dir, { recursive:true });
    }

    async #load_conf(conf) {
        this.conf = conf;
        this.use_https = !!(this.conf["core.https_port"] && (await this.#get_certs()));
        this.host = `${this.conf["core.hostname"]}:${this.conf["core.http_port"]}`;
        this.http_url = `http://${this.host}`;
        this.https_url = `https://${this.host}`;
        this.url = this.use_https ? this.https_url : this.http_url;
        this.#auth = this.conf["core.auth"] ? (await utils.import(this.conf["core.auth"])).default : null;
        if (this.#IS_MASTER) {
            await this.#init_appdata();
            fs.writeFileSync(this.conf_path, JSON.stringify(this.conf));
            if (this.#init_promise) this.#update_modules();
            this.ipc_broadcast("core.update-conf", this.conf);
        }
    }

    async authorise(req, res) {
        if (this.#auth) {
            try {
                return this.#auth(req, res);
            } catch (e) {
                console.error("authorise error", e);
            }
        } else {
            return true
        }
    }

    set_priority(pid, pri) {
        try {
            if (pid) os.setPriority(pid, pri);
            else os.setPriority(pri);
        } catch (e) {
            this.logger.warn(`Could not set process priority for pid: ${pid||process.pid}`);
        }
    }

    #get_inspect() {
        var argv = process.argv;
        if (this.#pm2_process) {
            argv = this.#pm2_process.pm2_env.node_args || this.#pm2_process.pm2_env.interpreter_args;
        }
        var inspect_arg = argv.find(a=>a.match(/^--inspect(-)?/)) || "";
        var inspect_hostname = "127.0.0.1";
        var inspect_port = 9229;
        var inspect_host = inspect_arg.split("=")[1] || `${inspect_hostname}:${inspect_port}`;
        if (inspect_host.match(/^[^:]+:\d+$/)) [inspect_hostname, inspect_port] = inspect_host.split(":");
        else inspect_hostname = inspect_host || inspect_hostname;
        return [inspect_hostname, +inspect_port];
    }

    async #destroy() {
        console.info("Handling shutdown...");
        if (this.#app && this.#app.destroy) await this.#app.destroy();
        await this.#cleanup_sockets();
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
        pid: p.pid,
    }
    return data;
}

export default core;
export * from "./internal.js";
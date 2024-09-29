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
import { ConfigLoader, Logger, utils, IPC } from "./internal.js";
// import pkg from "./package.json" with { type: "json" };
const __dirname = import.meta.dirname;
var rid = 0;

const core = new class Core extends events.EventEmitter {
    /** @type {typeof import("./config.default.js").default & typeof import("../file-manager/config.default.js").default & typeof import("../media-server/config.default.js").default & typeof import("../main/config.default.js").default} */
    conf = {};
    // just a map of name:path to dir
    modules = {};
    ppid = process.ppid;
    /** @type {Logger} */
    logger;
    #app;
    #auth;
    #IS_MASTER;
    // #pm2_description;
    /** @type {cron.ScheduledTask} */
    #compress_logs_cron;
    #init_promise;
    root_socket_path;
    /** @type {http.Server} */
    #proxy_http_server;
    /** @type {https.Server} */
    #proxy_https_server;
    /** @type {(http.Server | https.Server)[]} */
    #servers = [];
    
    get portable() { return !!(process.env.LIVESTREAMER_PORTABLE ?? this.conf["core.portable"]) ?? false };
    get debug() { return !!(process.env.LIVESTREAMER_DEBUG ?? this.conf["core.debug"]) ?? false; }
    
    async init(name, app) {
        if (this.ready) return;
        this.ready = (async()=>{
            
            this.#IS_MASTER = (name === "root");
            this.appspace = process.env.LIVESTREAMER_APPSPACE || "livestreamer";

            this.cwd = process.cwd();
            this.name = name;
            this.#app = app;
            this.logger = new Logger(this.name, {stdout:true, file:true});
            this.logger.console_adapter();

            this.tmp_dir = path.join(os.tmpdir(), this.appspace);
            this.socket_dir = path.join(this.tmp_dir, "socks");
            
            var exit_handler = async ()=>{
                console.log("SIGINT");
                await this.#destroy();
                process.exit(0);
            }
            process.on('SIGINT', exit_handler);
            process.on('SIGTERM', exit_handler);

            this.http_socket_path = this.get_socket_path(`${this.name}_http`);
            this.ipc_socket_path = this.get_socket_path(`ipc`);

            this.ipc = new IPC(this.#IS_MASTER, this.ipc_socket_path);
            
            // is this a good idea?
            process.on('unhandledRejection', (e) => {
                this.logger.error(`Unhandled Rejection:`, e);
            });
            process.on('message', async (packet)=>{
                if (typeof packet === "string") {
                    if (packet === "shutdown") {
                        await this.#destroy();
                    }
                }
            });

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
                this.ipc.on("update-conf", async (conf)=>{
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

            this.stdin_listener = readline.createInterface(process.stdin);
            this.stdin_listener.on("line", (line)=>{
                var parts = utils.split_spaces_exclude_quotes(line);
                this.emit("input", parts);
            });

            if (this.#IS_MASTER) {
                await this.#setup_proxies();
                await this.#compress_logs();
                this.#compress_logs_cron = cron.schedule(this.conf["core.compress_logs_schedule"], ()=>this.#compress_logs());
            }
            if (!process.env.pm_id) {
                await utils.promisify(pm2.connect.bind(pm2))(true);
            }
            // if (process.env.pm_id) {
            //     this.#pm2_description = await utils.promisify(pm2.describe.bind(pm2))(process.env.pm_id);
            // }
            
            this.#update_modules();

            if (this.#app && this.#app.init) await this.#app.init();
        })();
    }

    #update_modules() {
        let old_modules = {...this.modules};
        utils.clear(this.modules);
        for (let module_path of this.conf["core.modules"]) {
            module_path = path.resolve(module_path);
            let m = path.basename(module_path);
            this.modules[m] = module_path;
        }
        if (this.#IS_MASTER) {
            for (let m of Object.keys(this.modules)) {
                let p = this.ipc.get_process(m);
                if (!p) this.module_start(m);
            }
            for (let m in old_modules) {
                if (this.modules[m]) continue;
                let p = this.ipc.get_process(m);
                if (p) this.module_stop(m);
            }
        }
    }

    async module_start(m) {
        /** @type {pm2.StartOptions} */
        var p = {
            "max_restarts": 5,
            "name": `${this.appspace}.${m}`,
            "script": path.resolve(this.modules[m], "index.js"),
            "autorestart": true,
            "restart_delay": 5000,
            "node_args": [],
            // "cron_restart" : null // prevent inheriting
        };
        if (this.debug && this.conf[`${m}.inspect`]) {
            p.node_args.push(`--inspect=${this.conf[`${m}.inspect`]}`);
        }
        return utils.promisify(pm2.start.bind(pm2))(p);
    }

    async module_restart(m) {
        return utils.promisify(pm2.restart.bind(pm2))(`${this.appspace}.${m}`);
    }

    async module_stop(m) {
        return utils.promisify(pm2.stop.bind(pm2))(`${this.appspace}.${m}`);
    }

    get_socket_path(sock_name) {
        return utils.is_windows() ? `\\\\.\\pipe\\${this.appspace}_${sock_name}` : path.join(this.socket_dir, `${sock_name}.sock`);
    }

    async #cleanup_sockets() {
        if (!this.#IS_MASTER) return;
        if (utils.is_windows()) return;
        console.info("Cleaning up sockets...")
        for (var f of glob("**", {cwd: this.socket_dir, absolute: true})) {
            try {
                fs.rmSync(f);
                console.info(`Removed '${f}'`)
            } catch {
                console.error(`Could not delete '${f}'`);
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
        console.info(`Starting HTTP Server on port ${this.conf["core.http_port"]}`);

        /** @param {http.IncomingMessage} req @param {string} name */
        var get_proxy = (req)=>{
            var url = new URL(req.url, "http://localhost");
            var parts = url.pathname.slice(1).split("/");
            var name = parts[0];
            var proxy, target;
            // for some reason this adds a big delay to any request... can't figure it out
            if (this.ipc.get_process(name)) {
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
        const request_listener = (req, res)=>{
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
        };
        if (this.conf["core.http_port"]) {
            this.#proxy_http_server = http.createServer(request_listener);
            this.#proxy_http_server.listen(this.conf["core.http_port"]);
            this.#servers.push(this.#proxy_http_server);
        }
        var certs = await this.#get_certs();
        if (this.conf["core.https_port"] && certs) {
            console.info(`Starting HTTPS Server on port ${this.conf["core.https_port"]}`);
            this.#proxy_https_server = https.createServer(certs, request_listener);
            this.#proxy_https_server.listen(this.conf["core.https_port"]);
            this.#servers.push(this.#proxy_https_server);
            setInterval(async ()=>{
                var certs = await this.#get_certs();
                if (certs) this.#proxy_https_server.setSecureContext(certs);
            }, 1000*60*60*24*7) // every week
        }

        for (var s of this.#servers) {
            s.keepAliveTimeout = (60 * 1000);
            s.headersTimeout = (60 * 1000);
            s.on('upgrade', handle_upgrade);
        }
    }

    async #get_certs(){
        try { return { key: await fs.readFile(this.conf["core.ssl_key"]), cert: await fs.readFile(this.conf["core.ssl_cert"]) }; } catch {}
    }

    async #compress_logs() {
        await utils.compress_logs_directory(this.logs_dir);
        this.ipc.emit("compress_logs");
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
            this.ipc.emit("update-conf", this.conf);
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

    // #get_inspect() {
    //     var argv = process.argv;
    //     if (this.#pm2_description) {
    //         argv = this.#pm2_description.pm2_env.node_args || this.#pm2_description.pm2_env.interpreter_args;
    //     }
    //     var inspect_arg = argv.find(a=>a.match(/^--inspect(-)?/)) || "";
    //     var inspect_hostname = "127.0.0.1";
    //     var inspect_port = 9229;
    //     var inspect_host = inspect_arg.split("=")[1] || `${inspect_hostname}:${inspect_port}`;
    //     if (inspect_host.match(/^[^:]+:\d+$/)) [inspect_hostname, inspect_port] = inspect_host.split(":");
    //     else inspect_hostname = inspect_host || inspect_hostname;
    //     return [inspect_hostname, +inspect_port];
    // }

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
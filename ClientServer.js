const WebSocket = require("ws");
const path = require("node:path");
const fs = require("fs-extra");

/** @template {ClientBase} T  */
class ClientServer {
    #$_changes = [];
    /** @type {Record<string,T>} */
    clients = {};
    #cid = 0;
    #client_history = {};
    
    /** @param {WebSocket.Server} wss @param {new () => T} ClientClass */
    constructor(id, wss, $, ClientClass, auth) {
        this.id = id;
        this.clients_filename = path.join(core.clients_dir, id);

        this.logger = new Logger(`client-server`);
        this.logger.on("log", (log)=>{
            core.logger.log(log)
        });
        this.ready = utils.deferred();
        this.wss = wss;

        wss.on("connection", async (ws, request)=>{
            await this.ready;
            var user = null;
            user = await core.authorise(request);
            if (auth && !user) {
                ws.close(1014, "go away");
                return;
            }
            var alive = true;
            var client = new ClientClass(++this.#cid, this, ws, request, user);
            client.init();

            this.clients[client.id] = client;
            this.#client_history[client.id] = client.$;

            await fs.appendFile(this.clients_filename, JSON.stringify(client.$)+"\n", "utf8");

            var heartbeat_interval = setInterval(()=>{
                if (!alive) {
                    this.logger.info(`${client.id} websocket did not respond to ping`);
                    return ws.terminate();
                }
                alive = false;
                ws.send("ping");
            }, 30 * 1000);

            ws.send("ping");

            ws.on('message',(data, isBinary)=>{
                if (data === "pong") {
                    alive = true;
                    return;
                }
                client._onmessage(data, isBinary);
            });
            ws.on('error',(e)=>{
                client._onerror(e);
            });
            ws.on("close", (code)=>{
                client._onclose(code);
                clearInterval(heartbeat_interval);
                delete this.clients[client.id];
            });
        });

        utils.Observer.listen($, c=>this.#$_changes.push(c));

        this.load_history();
        
        setInterval(()=>this.update_clients(), 100);
    }

    init() {
        this.ready.resolve();
    }

    async load_history() {
        var lines = (await fs.exists(this.clients_filename)) ? (await utils.read_last_lines(this.clients_filename, 512, "utf8")) : [];
        lines.pop();
        this.#client_history = Object.fromEntries(lines.map((line)=>{
            var data = JSON.parse(line.trim());
            this.#cid = Math.max(this.#cid, data.id);
            return [data.id, data];
        }));
    }

    get_client_info(id) {
        return this.#client_history[id];
    }

    destroy() {
        this.update_client_interval.destroy();
    }
    update_clients() {
        if (!this.#$_changes.length) return;
        var $ = utils.Observer.flatten_changes(this.#$_changes);
        this.send_clients({$});
        utils.clear(this.#$_changes);
    }

    send_clients(d) {
        Object.values(this.clients).forEach(c=>c.send(d));
    }
}

module.exports = ClientServer;

const utils = require("./utils");
const ClientBase = require("./ClientBase");
const Logger = require("./Logger");
const core = require(".");
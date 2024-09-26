import http from "node:http";
import WebSocket from "ws";
import { core, utils, DataNode, Logger, ClientServer } from "./internal.js";

class ClientBase extends DataNode {

    get ip() { return this.$.ip; }
    get ip_hash() { return this.$.ip_hash; }
    get username() { return this.$.username; }
    get is_admin() { return !!this.$.is_admin; }
    #initialized = false;

    /**
     * @param {ClientServer} server
     * @param {http.IncomingMessage} req
     * @param {WebSocket} ws
     */
    constructor(id, server, ws, req, userdata) {
        super(id);
        
        this.server = server;
        this.ws = ws;
        this.request = req;
        this.url = new URL("http://localhost"+req.url);
        
        var ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress).split(",")[0];

        this.logger = new Logger(`client-${id}`);
        this.logger.on("log", (log)=>server.logger.log(log));
        
        Object.assign(this.$, {
            ip: ip,
            ip_hash: utils.md5(ip),
            init_ts: Date.now(),
        });
        if (userdata && typeof userdata === "object") {
            Object.assign(this.$, userdata);
        }

        this.logger.info(`${JSON.stringify(this.$)} connected`);
    }
    

    _onclose(code){
        this.logger.info(`disconnected.`);
        this.destroy();
    }

    async _onmessage(m) {
        this.logger.debug(`message: ${m}`);
        var request;
        try {
            request = JSON.parse(m);
        } catch {
            this.logger.warn("Bad request.");
            return;
        }
        var request_id = request.__id__;
        var result, error;
        // var fn_path = Array.isArray(request.path) ? request.path : String(request.path).split(/[\.\/]+/);
        var run = ()=>{
            if (request.call) result = utils.call(this, request.call, request.arguments);
            else if (request.get) result = utils.get(this, request.get);
            else if (request.set) result = utils.set(this, request.set, request.value);
            else error = `Invalid request: ${JSON.stringify(request)}`;
        };
        if (core.debug) {
            run();
        } else {
            try { run(); } catch (e) { error = e; }
        }
        result = await Promise.resolve(result).catch(e=>{
            error = e;
        });
        result = {
            __id__: request_id,
            result,
        };
        if (error) {
            this.logger.error(error);
            result.error = { message: error.toString() }
        }
        this.send(result);
        this.server.update_clients();
    }

    _onerror(error){
        this.logger.error(error);
    }

    init() { return new Error("Not implemented."); }

    send(d) {
        if (!this.#initialized) {
            this.#initialized = true;
            d.init = {
                client_id: this.id,
                ts: Date.now(),
            }
        }
        this.ws.send(JSON.stringify(d, (k,v)=>(v===undefined)?null:v));
    }

    destroy() {
        super.destroy();
        this.ws.close();
    }
}

export default ClientBase;
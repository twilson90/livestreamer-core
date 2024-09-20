const http = require("node:http");
const WebSocket = require("ws");
const DataNode = require("./DataNode");

class ClientBase extends DataNode {

    get ip() { return this.$.ip; }
    get ip_hash() { return this.$.ip_hash; }
    get username() { return this.$.username; }
    get is_admin() { return !!this.$.is_admin; }

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
        
        var ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress).split(",")[0];

        this.logger = new Logger(`client-${id}`);
        this.logger.on("log", (log)=>server.logger.log(log));
        
        Object.assign(this.$, {
            ip: ip,
            ip_hash: utils.md5(ip),
            init_ts: Date.now(),
        });
        if (userdata) {
            Object.assign(this.$, userdata);
        }

        this.logger.info(`${JSON.stringify(this.$)} connected`);

        this.send({
            init:{
                ts: Date.now(),
                client_id: this.id,
            }
        });
    }
    

    _onclose(code){
        this.logger.info(`disconnected.`);
        this.destroy();
    }

    async _onmessage(m, isBinary) {
        this.logger.debug(`message: ${m}`);
        var request;
        if (typeof m === "string") {
            try {
                request = JSON.parse(m);
            } catch {
                this.logger.warn("Bad request.");
                return;
            }
        } else if (m instanceof Buffer) {
            // hmm
            return;
        }
        var request_id = request.__id__;
        var result, error;
        // var fn_path = Array.isArray(request.path) ? request.path : String(request.path).split(/[\.\/]+/);
        try {
            if (request.call) result = utils.call(this, request.call, request.arguments);
            else if (request.get) result = utils.get(this, request.get);
            else if (request.set) result = utils.set(this, request.set, request.value);
            else error = `Invalid request: ${JSON.stringify(request)}`;
        } catch (e) {
            error = e;
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

    send(data) {
        this.ws.send(JSON.stringify(data, (k,v)=>(v===undefined)?null:v));
    }

    destroy() {
        super.destroy();
        this.ws.close();
    }
}

module.exports = ClientBase;

const utils = require("./utils");
const Logger = require("./Logger");
const ClientServer = require("./ClientServer");
const core = require(".");
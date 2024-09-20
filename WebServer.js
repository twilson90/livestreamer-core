const http = require("node:http");
const https = require("node:https");
const fs = require("fs-extra");
const WebSocket = require("ws");
// const auth = require("basic-auth");
// const url = require("node:url");
// const compression = require("compression");
// const accesslog = require("access-log");

/** @typedef {{http_port:Number, https_port:Number, username:string, password:string, ssl_key:string, ssl_cert:string, socket_path:string, ws:WebSocket.ServerOptions<typeof WebSocket, typeof http.IncomingMessage>}} Config */
module.exports = class {
    /** @type {http.Server} */
    server;
    /** @param {http.RequestListener<typeof http.IncomingMessage, typeof http.ServerResponse>} handler @param {Config} opts */
    constructor(handler, opts) {
        opts = {
            allow_origin: "*",
            auth: false,
            ws: {
                noServer: true,
                perMessageDeflate: {
                    zlibDeflateOptions: {
                        chunkSize: 1024,
                        memLevel: 7,
                        level: 3
                    },
                    zlibInflateOptions: {
                        chunkSize: 10 * 1024
                    },
                    clientNoContextTakeover: true, // Defaults to negotiated value.
                    serverNoContextTakeover: true, // Defaults to negotiated value.
                    serverMaxWindowBits: 10, // Defaults to negotiated value.
                    concurrencyLimit: 10, // Limits zlib concurrency for perf.
                    threshold: 1024 // Size (in bytes) below which messages should not be compressed.
                }
            },
            ...opts,
        }

        /** @type {https.ServerOptions<typeof http.IncomingMessage, typeof http.ServerResponse>} */
        var http_opts = {};

        core.logger.info(`Starting HTTP server on socket ${core.proxy_socket_path}...`);
        this.server = http.createServer(http_opts, async (req, res)=>{
            // accesslog(req, res, undefined, (l)=>core.logger.debug(l));
            if (opts.auth) {
                let auth_res = await core.authorise(req, res);
                if (!auth_res) {
                    res.setHeader('WWW-Authenticate', 'Basic realm="Authorized"');
                    res.statusCode = 401;
                    res.write('Unauthorized access');
                    res.end();
                    return;
                }
            }
            //if (req.headers.referrer || req.headers.referer) {
            // var url = new URL(req.headers.referrer || req.headers.referer);
            // var url = new URL(core.conf["cabtv.site_url"]);
            var allow_origin = opts.allow_origin;
            // var allow_origin = [...new Set([`${url.protocol}//${url.hostname}:*`, `${url.protocol}//${core.conf["hostname"]}:*`])].join(" ");
            res.setHeader('Access-Control-Allow-Origin', allow_origin);
            res.setHeader('Access-Control-Allow-Credentials', true);
            res.setHeader('Access-Control-Allow-Methods', 'POST, GET, PUT, DELETE, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Origin, Accept, X-Requested-With, Content-Type, Authorization, Access-Control-Allow-Headers, Access-Control-Request-Method, Access-Control-Request-Headers');
            res.setHeader('Content-Security-Policy', `frame-ancestors 'self' ${allow_origin}`);
            // res.setHeader('Content-Security-Policy', `default-src 'self' ${host}`);

            //}
            res.setHeader('Vary', "Origin");
            if (req.method === 'OPTIONS') {
                res.statusCode = 200;
                res.end();
            } else if (handler) {
                handler(req, res);
            }
        });
        this.server.listen(core.proxy_socket_path);
        
        if (opts.ws) {
            this.server.on('upgrade', (request, socket, head)=>{
                this.wss.handleUpgrade(request, socket, head, (socket)=>{
                    this.wss.emit('connection', socket, request);
                });
            });
            this.wss = new WebSocket.Server(opts.ws);
            this.wss.on("error", (error)=>{
                core.logger.error(error);
            });
        }
    }

    async destroy() {
        await new Promise(r=>{this.server.close(r); this.server=null;});
    }
}

const core = require(".");
const utils = require("./utils");
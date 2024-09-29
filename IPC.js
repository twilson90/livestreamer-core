import events from "node:events";
import net from "node:net";
import readline from "node:readline";
import {core, utils} from "./internal.js";

/** @typedef {{name:string,pid:number,ppid:number,sock:net.Socket}} Process */
export default class IPC extends events.EventEmitter {
    /** @type {Record<any,Process>} */
    processes = {};
    /** @type {Record<string,net.Socket>} */
    socks = {};
    /** @type {net.Socket} */
    master_sock;
    socket_last_id = 0;
    /** @type {Record<string,Function(...args:any):any>} */
    responses = {};
    rid = 0;
    constructor(is_master, socket_path) {
        super();
        this.is_master = is_master;
        this.pid = process.pid;
        this.ppid = process.ppid;
        /** @type {Process} */
        let proc = {
            name: core.name,
            pid: this.pid,
            ppid: this.ppid,
            sock: null
        };
        this.processes[this.pid] = proc;
        if (is_master) {
            net.createServer((sock)=>{
                let pid;
                let sock_id = ++this.socket_last_id;
                this.socks[sock_id] = sock;
                sock.on('end', ()=>{
                    delete this.socks[sock_id];
                    if (this.processes[pid]) {
                        delete this.processes[pid];
                        this.emit("internal:processes", {processes: this.processes});
                    }
                });
                digest_sock_messages(sock, ({event, data})=>{
                    if (event === "internal:register") {
                        pid = data.process.pid;
                        this.processes[pid] = {...data.process, sock};
                        this.emit("internal:processes", {processes: this.processes});
                    } else if (event === "internal:send") {
                        let {pid, event, data:_data} = data;
                        this.send(pid, event, _data);
                    } else if (event === "internal:emit") {
                        let {event, data:_data} = data;
                        this.emit(event, _data);
                    } else {
                        throw new Error(`Unrecognized event: ${event}`);
                    }
                });
            }).listen(socket_path);
        } else {
            this.master_sock = net.createConnection(socket_path);
            this.master_sock.on('connect', ()=>{
                send(this.master_sock, "internal:register", {process: proc});
            });
            digest_sock_messages(this.master_sock, async ({event,data})=>{
                if (event === "internal:processes") {
                    this.processes = data.processes;
                } else if (event === "internal:request") {
                    let {rid, origin, request, args} = data;
                    await core.ready;
                    Promise.resolve(this.responses[request](...args))
                        .then((result)=>[result, null])
                        .catch((err)=>[null, err])
                        .then(([result,err])=>{
                            this.send(origin, `internal:response:${rid}`, [result, err]);
                        });
                }
                super.emit(event, data);
            });
            this.master_sock.on('error', (err)=>{
                console.error(err)
            });
        }
    }
    emit(event, data) {
        if (this.is_master) {
            return Promise.all(Object.values(this.socks).map(sock=>send(sock, event, data)));
        } else {
            return send(this.master_sock, `internal:emit`, {event, data});
        }
    }
    async send(pid, event, data) {
        if (this.is_master) {
            return utils.retry_until(()=>{
                let p = this.get_process(pid);
                return send(p.sock, event, data)
            }, 5, 1000, `IPC.send ${pid} ${event}`);
        } else {
            return send(this.master_sock, `internal:send`, {pid, event, data});
        }
    }
    get_process(pid) {
        return this.processes[pid] || Object.values(this.processes).find(p=>p.name === pid);
    }
    respond(request, listener) {
        if (this.responses[request]) throw new Error(`IPC: '${request}' response already setup`);
        this.responses[request] = listener;
    }
    request(pid, request, args, _default) {
        return new Promise(async (resolve,reject)=>{
            let rid = ++this.rid;
            if (!args) args = [];
            this.send(pid, "internal:request", { rid, request, args, origin: this.pid });
            this.once(`internal:response:${rid}`, ([result,err])=>{
                if (err && _default === undefined) reject(err);
                else resolve(result ?? _default);
            })
        });
    }
}

/** @param {net.Socket} sock */
function digest_sock_messages(sock, cb) {
    readline.createInterface(sock).on("line", (line)=>{
        if (line) cb(JSON.parse(line));
    });
}
/** @param {net.Socket} sock @param {any} packet */
function send(sock, event, data) {
    return new Promise((resolve,reject)=>{
        let payload = JSON.stringify({event, data})+"\n";
        sock.write(payload, (err)=>{
            if (err) reject(err)
            else resolve();
        });
    });
}
const execa = require("execa");
const events = require("node:events");
const net = require("node:net");
const os = require("node:os");
const tree_kill = require("tree-kill");
const path = require("node:path");
const fs = require("fs-extra");
const readline = require("node:readline");

const TIMEOUT = 10 * 1000;
const default_observes = [
    "playlist",
    "playlist-count",
    "playlist-pos",
    "idle-active",
    "time-pos",
    "volume",
    "mute",
];

class MPVWrapper extends events.EventEmitter {
    #message_id;
    #observed_id;
    #socket_requests;
    #observed_properties;
    #quitting = false;
    #observed_props;
    /** @type {execa.ExecaChildProcess<string>} */
    #process;
    /** @type {net.Socket} */
    #socket;
    options;
    args;
    logger;

    get observed_props() { return this.#observed_props; }
    get process() { return this.#process; }
    get quitting() { return this.#quitting; }
    get cwd() { return path.resolve(this.options.cwd); }

    constructor(options) {
        super();

        this.options = options = {
            executable: "mpv",
            cwd: ".",
            ...options,
        };
        
        this.socket_path = core.socket_path(`mpv-ipc-${utils.uuidb64()}`);

        this.logger = new Logger("mpv");
    }

    /** @param {string[]} args */
    async start(args=[]) {
        args = [
            ...args,
            `--input-ipc-server=${this.socket_path}`,
            "--idle",
            "--msg-level=all=status,ipc=v" //all=no,
        ];
        this.args = args;
        this.#message_id = 0;
        this.#observed_id = 0;
        this.#socket_requests = {}
        this.#observed_properties = {};
        this.#observed_props = {};
        this.#process = null;

        this.#socket = new net.Socket();
        
        this.logger.info("Starting MPV...");
        this.logger.info("MPV args:", args);
        
        var instance_running;
        if (await this.#try_start_socket()) {
            try {
                await this.get_property("mpv-version");
                instance_running = true;
            } catch {}
        }
        if (!instance_running) {
            this.#process = utils.exec(this.options.executable, args, {cwd: this.cwd});
            this.#process.on("close", (e)=>{
                this.#process.__closed__ = true;
                this.quit();
            });
            core.set_priority(this.#process.pid, os.constants.priority.PRIORITY_HIGHEST);
            // this.#process.on("error", (e)=>{
            //     console.error(e);
            // });
            var stderr_listener = readline.createInterface(this.#process.stderr);
            var stdout_listener = readline.createInterface(this.#process.stdout);
            try {
                await utils.promise_timeout(
                    new Promise((resolve, reject)=>{
                        console.log("Waiting for IPC to signal open...");
                        let check = (line)=>{
                            console.log(line);
                            if (line.match(/Listening to IPC (socket|pipe)/)) {
                                resolve();
                            } else if (line.match(/Could not bind IPC (socket|pipe)/)) {
                                reject();
                            }
                        };
                        stderr_listener.on("line", check);
                        stdout_listener.on("line", check);
                    }),
                    5000
                );
            } catch (e) {
                this.logger.error(e);
                await this.quit();
                return;
            }
            stdout_listener.close();
            stderr_listener.close();

            this.logger.info(`MPV started successfully.`);

            await this.#try_start_socket();
            
            var msg_handler;
            await utils.promise_timeout((resolve, reject) => {
                msg_handler = (message)=>{
                    if ("event" in message && ["idle","idle-active","file-loaded"].includes(message.event)) {
                        resolve();
                    } else if ("data" in message && "error" in message && message.error === "success") { // ???
                        resolve();
                    }
                }
                this.on("message", msg_handler);
                this.get_property("idle-active");
            }, 1000).catch(e=>{
                this.logger.warn("No initial idle signal detected, attempting to start anyway.");
            });
            this.off("message", msg_handler);
        }

        for (var o of default_observes) {
            await this.observe_property(o).catch(e=>this.logger.error(e));
        }
    }

    async stop() {
        await this.command("stop");
        if (this.#observed_props["idle-active"]) return;
        var handler;
        await new Promise((resolve)=>{
            handler = resolve;
            this.on("idle", handler);
        });
        this.off("idle", handler);
    }

    async quit() {
        if (this.#quitting) return;
        this.#quitting = true;
        this.emit("before-quit");
        if (this.#process && !this.#process.__closed__) {
            this.command("quit");
            await new Promise(resolve=>{
                this.#process.once("close", resolve);
                setTimeout(()=>{
                    if (this.#process.__closed__) return;
                    this.logger.warn("Quit signal not working. Terminating MPV process tree with force...");
                    tree_kill(this.#process.pid, "SIGKILL");
                }, 2000);
                setTimeout(()=>{
                    if (this.#process.__closed__) return;
                    this.logger.error("Process tree kill hasn't hasn't worked! Uh oh.");
                    resolve();
                }, 5000);
            }).catch((e)=>{
                this.logger.error("quit error:", e);
            });
        }
        this.emit("quit");
        this.removeAllListeners();
        
        if (this.#socket) {
            this.#socket.removeAllListeners();
            this.#socket.destroy();
        }
        await fs.unlink(this.socket_path).catch(()=>{});
    }

    destroy() {
        this.quit();
        this.logger.destroy();
    }

    async #try_start_socket(){
        var result = await new Promise(resolve=>{
            this.#socket.on("error", ()=>resolve(false));
            this.#socket.connect({path: this.socket_path}, ()=>resolve(true));
        });
        this.#socket.removeAllListeners("error");
        if (result) {
            this.#init_socket();
        }
        return result;
    }

    #init_socket() {
        this.#socket.on("close", ()=>this.quit());
        this.#socket.on("error", (error)=>{
            this.logger.error("socket error:", error);
        });
        var socket_listener = readline.createInterface(this.#socket);
        socket_listener.on("line", (msg)=>{
            if (msg.length > 0) {
                try {
                    msg = JSON.parse(msg);
                } catch {
                    this.logger.error(`Invalid JSON MPV Socket message:`, msg);
                    return;
                }
                if (msg.request_id && msg.request_id !== 0) {
                    var req = this.#socket_requests[msg.request_id];
                    delete this.#socket_requests[msg.request_id];
                    if (msg.error === "success") req.resolve(msg.data);
                    else req.reject({error: msg.error, command:req.command});
                } else {
                    if (msg.event == "property-change") {
                        this.#observed_props[msg.name] = msg.data;
                    }
                    this.emit("message", msg);
                    if ("event" in msg) {
                        this.emit(msg.event, msg);
                    }
                }
            }
        });
    }

    // ----------------------------------------------

    async load_next(mode = "weak") {
        if ((this.#observed_props["playlist-pos"]+1) >= this.#observed_props["playlist-count"]) {
            if (mode === "weak") return false;
            await this.command("stop");
        } else {
            await this.on_load_promise(this.command("playlist-next", mode));
        }
    }

    async playlist_prev(mode = "weak") {
        if (this.#observed_props["playlist-pos"] == 0) {
            if (mode === "weak") return false;
            await this.command("stop");
            return true;
        }
        await this.on_load_promise(this.command("playlist-prev", mode));
    }
    
    async playlist_jump(position, force_play=true) {
        if (position < 0 || position >= this.#observed_props["playlist-count"]) return false;
        var prom = (force_play) ? this.command("playlist-play-index", position) : this.set_property("playlist-current-pos", position);
        await this.on_load_promise(prom);
    }
    
    async playlist_remove(position) {
        if (position < 0 || position >= this.#observed_props["playlist-count"]) return false;
        var item = this.#observed_props["playlist"][position];
        await this.on_playlist_change_promise(this.command("playlist-remove", position));
        return item ? item.id : null;
    }
    
    async playlist_move(index1, index2) {
        ;
        await this.on_playlist_change_promise(this.command("playlist-move", index1, index2));
    }
    
    // removes every file from playlist EXCEPT currently played file.
    async playlist_clear() {
        if (this.#observed_props["playlist-count"] == 0) return;
        var n = (this.#observed_props["playlist-pos"] > -1) ? 1 : 0;
        await this.on_playlist_change_promise(this.command("playlist-clear"), n);
    }
    
    async loadlist(url, flags = "replace") {
        var prom = this.command("loadlist", url, flags);
        if (flags == "append") await this.on_playlist_change_promise(prom);
        else await this.on_load_promise(prom);
    }
    
    async reload() {
        var time_pos = this.#observed_props["time-pos"];
        await this.playlist_jump(this.#observed_props["playlist-pos"]);
        await this.seek(time_pos);
    }

    set_property(property, value) {
        return this.command("set_property", property, value);
    }

    get_property(property) {
        return this.command("get_property", property);
    }

    add_property(property, value) {
        return this.command("add", property, value);
    }

    multiply_property(property, value) {
        return this.command("multiply", property, value);
    }

    cycle_property(property) {
        return this.command("cycle", property);
    }

    observe_property(property) {
        if (this.#observed_properties[property] !== undefined) return;
        const prop_id = ++this.#observed_id;
        this.#observed_properties[property] = prop_id;
        return this.command("observe_property", prop_id, property);
    }

    unobserve_property(property) {
        if (this.#observed_properties[property] === undefined) return;
        const prop_id = this.#observed_properties[property];
        delete this.#observed_properties[property];
        return this.command("unobserve_property", prop_id);
    }

    request_log_messages(level) {
        return this.command("request_log_messages", level);
    }

    async seek(seconds, flags="absolute+exact") {
        var msg_handler;
        let seek_event_started = false;
        await new Promise((resolve,reject)=>{
            msg_handler = (msg)=>{
                if ("event" in msg) {
                    if (msg.event === "seek") {
                        seek_event_started = true;
                    } else if (seek_event_started && msg.event === "playback-restart") {
                        resolve();
                    }
                }
            }
            this.on("message", msg_handler);
            this.command("seek", seconds, flags).catch(reject);
        });
        this.off("message", msg_handler);
    }

    async loadfile(source, flags = "replace", options = {}) {
        var params = [source, flags];
        if (options) params.push(options);
        var prom = this.command("loadfile", ...params);
        var item;
        if (flags === "replace" || (flags === "append-play" && this.#observed_props["idle-active"])) {
            await this.on_load_promise(prom);
            item = this.#observed_props["playlist"][this.#observed_props["playlist-pos"]];
        } else {
            var new_count = this.#observed_props["playlist-count"]+1;
            await this.on_playlist_change_promise(prom, new_count);
            item = this.#observed_props["playlist"][new_count-1];
        }
        return item ? item.id : null;
    }

    // ----------------------------------------------

    command(...command) {
        return new Promise((resolve, reject)=>{
            if (this.#socket.destroyed) {
                this.logger.warn("Command", command, "failed, socket is destroyed..")
                // setImmediate(()=>reject("Socket is destroyed."));
                return;
            }
            const request_id = ++this.#message_id;
            const msg = { command, request_id };
            this.#socket_requests[request_id] = {
                command: command,
                resolve: resolve,
                reject: reject,
            };
            try {
                this.#socket.write(JSON.stringify(msg) + "\n");
            } catch (e) {
                reject(e);
                return;
            }
        })
    }

    // remember playlist-count observe message always comes after playlist
    async on_playlist_change_promise(promise, count) {
        var handler;
        await utils.promise_timeout((resolve, reject)=>{
            if (count === undefined) {
                handler = (e)=>{
                    if (e.name == "playlist") resolve();
                }
            } else {
                handler = (e)=>{
                    if (e.name == "playlist-count" && e.data == count) resolve();
                }
            }
            this.on("property-change", handler);
            if (promise) promise.catch(reject);

        }, TIMEOUT).catch(e=>{
            this.logger.error(e)
        });
        this.off("property-change", handler);
        return true;
    }

    async on_load_promise(promise) {
        var handler;
        let started = false;
        await utils.promise_timeout((resolve, reject)=>{
            handler = (msg)=>{
                if ("event" in msg) {
                    if (msg.event === "start-file") {
                        started = true;
                    } else if(msg.event === "file-loaded" && started) {
                        resolve();
                    } else if (msg.event === "end-file" && started) {
                        reject("Error");
                    }
                }
            };
            if (promise) promise.catch(reject);
            this.on("message", handler);
        }, TIMEOUT).catch(e=>{
            this.logger.error(e)
        });
        this.off("message", handler);
        return true;
    }
}

module.exports = MPVWrapper;

const core = require(".");
const utils = require("./utils");
const Logger = require("./Logger");
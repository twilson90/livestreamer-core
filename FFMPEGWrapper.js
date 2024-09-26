import os from "node:os";
import events from "node:events";
import readline from "node:readline";
import child_process from "node:child_process";
import { utils, Logger, core } from "./internal.js";

class FFMPEGWrapper extends events.EventEmitter {
    /** @type {import("child_process").ChildProcessWithoutNullStreams} */
    #process;
    #logger;
    #closed;
    #running;

    get process() { return this.#process; }
    get logger() { return this.#logger; }

    constructor() {
        super();
        this.#logger = new Logger("ffmpeg");
    }

    /** @param {string[]} args @param {child_process.SpawnOptionsWithoutStdio} opts */
    start(args, opts) {
        this.#closed = false;
        this.#running = true;
        
        this.#logger.info("Starting FFMPEG...");
        this.#logger.debug("FFMPEG args:", args);
        
        this.#process = child_process.spawn(core.conf["core.ffmpeg_executable"], args, {windowsHide: true, ...opts});

        core.set_priority(this.#process.pid, os.constants.priority.PRIORITY_HIGHEST);

        this.#process.on("error", (e) => {
            // must consume errors! om nom nom
            if (this.#closed) return;
            this.#logger.error(e);
            this.emit("error", e.message);
            this.stop();
        });
        this.#process.on("close", (code) => {
            this.#closed = true;
            this.#running = false;
            this.emit("end");
        });
        // this.#process.on("exit", () => {});
        // this.#process.stderr.on("error", (e)=>console.error("ffmpeg stderr error", e));
        // this.#process.stdin.on("error",  (e)=>console.error("ffmpeg stdin error", e));
        // this.#process.stdout.on("error", (e)=>console.error("ffmpeg stdout error", e));
        // this.#process.stderr.on("close", (e)=>{});
        // this.#process.stdin.on("close",  (e)=>{});
        // this.#process.stdout.on("close", (e)=>{});

        let last_info, last_ts;
        let listener = readline.createInterface(this.#process.stderr);
        listener.on("line", line=>{
            if (line.startsWith("[fifo")) return;
            this.#logger.debug(line);
            this.emit("line", line);
            var m = line.match(/^(?:frame=\s*(.+?) )?(?:fps=\s*(.+?) )?(?:q=\s*(.+?) )?size=\s*(.+?) time=\s*(.+?) bitrate=\s*(.+?) speed=(.+?)x/);
            if (m) {
                var ts = Date.now();
                var info = {
                    frame: parseInt(m[1]),
                    fps: parseInt(m[2]),
                    q: parseInt(m[3]),
                    size: m[4],
                    time: utils.timespan_str_to_ms(m[5], "hh:mm:ss"),
                    bitrate: m[6],
                    speed: parseFloat(m[7]),
                    speed_alt: 1,
                }
                if (last_info) {
                    info.speed_alt = (info.time - last_info.time) / (ts - last_ts);
                }
                this.emit("info", info);
                last_info = info;
                last_ts = ts;
            }
        });
    }

    stop() {
        if (this.#running) return;
        this.#running = false;
        this.#process.kill();
    }

    destroy() {
        this.stop();
        this.#logger.destroy();
    }
}

export default FFMPEGWrapper;
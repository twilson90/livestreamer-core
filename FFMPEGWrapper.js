const path = require("node:path");
const os = require("node:os");
const execa = require("execa");
const events = require("node:events");
const readline = require("node:readline");

class FFMPEGWrapper extends events.EventEmitter {
    /** @type {execa.ExecaChildProcess} */
    process;
    logger;
    #running = false;

    get running() { return this.#running; }

    constructor() {
        super();
        this.logger = new Logger("ffmpeg");
    }

    /** @param {{use_tee_muxer:boolean, use_fifo:boolean, outputs:string[]}} options */
    start(args) {
        if (this.#running) return;

        this.logger.info("Starting FFMPEG...");
        this.logger.debug("FFMPEG args:", args);
        this.process = execa(core.conf["ffmpeg_executable"], args);
        this.#running = true;

        core.set_priority(this.process.pid, os.constants.priority.PRIORITY_HIGHEST);

        this.process.catch((e)=>{
            if (!this.#running) return;
            this.logger.error("ffmpeg fatal error:", e);
            this.stop();
        });
        this.process.on("error", (e) => {
            this.logger.error("ffmpeg error:", e);
            this.emit("error", e);
        });
        this.process.on("close", (code) => {
            this.#running = false;
            this.emit("end");
        });

        let last_info, last_ts;
        let listener = readline.createInterface(this.process.stderr);
        listener.on("line", line=>{
            if (line.startsWith("[fifo")) return;
            this.logger.debug(line);
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

        return this.process;
    }

    stop() {
        if (!this.#running) return;
        this.#running = false;
        this.process.kill();
        /* if (!this.process.stdout.destroyed) {
            await new Promise(resolve=>{
                this.process.once("close", resolve);
                tree_kill(this.process.pid, "SIGKILL");
            });
        } */
    }

    destroy() {
        this.stop();
        this.logger.destroy();
    }
}

module.exports = FFMPEGWrapper;

const utils = require("./utils");
const Logger = require("./Logger");
const core = require(".");
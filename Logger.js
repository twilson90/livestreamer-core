const events = require("node:events");
const fs = require("fs-extra");
const path = require("node:path");

const info = console.info;
const warn = console.warn;
const error = console.error;
const debug = console.debug;

class Log {
	level;
	message;
	prefix;
	ts;
	constructor(...args) {
		while (args[args.length-1] instanceof Log) {
			/** @type {Log} */
			let log = args.pop();
			this.level = log.level;
			this.message = log.message;
			this.prefix = log.prefix;
			this.ts = log.ts;
		}
		if (args.length) {
			this.level = args.shift();
		}
		if (args.length) {
			this.message = args.map(m=>{
				if (m instanceof Error) m = m.stack;
				if (typeof m === "object") {
					try { m = JSON.stringify(m) } catch {};
				}
				if (typeof m !== "string") m = String(m);
				if (m.length > core.conf["logs_max_msg_length"]) m = m.substr(0, core.conf["logs_max_msg_length"]);
				return m;
			}).join(" ");
		}
		this.prefix = this.prefix || "";
		this.ts = this.ts || Date.now();
		this.level = this.level || Logger.INFO;
	}
	toString() {
		var now = new Date();
		let t = `${now.toLocaleTimeString(undefined,{hour12:false})}.${now.getMilliseconds().toString().padStart(3,"0")}`;
		return `[${t}][${this.level[0]}]${this.prefix} ${this.message}`;
	}
}
class Logger extends events.EventEmitter {
	static ERROR = "error";
	static WARN = "warn";
	static INFO = "info";
	static DEBUG = "debug";
	
	/** @type {import("stream").Writable} */
	#stream;
	#filename;
	#settings;

	/** @param {{file:boolean, stdout:boolean}} settings */
	constructor(name, settings) {
		super();
		this.name = name;
		this.#settings = {
			file: false,
			stdout: false,
			...settings
		};
		if (!name) this.#settings.file = false;
	}

	#process_log(...args) {
		var log = new Log(...args);
		if (this.name) log.prefix = `[${this.name}]${log.prefix}`;
		return log;
	}

	warn() { this.log(Logger.WARN, ...arguments); }
	info() { this.log(Logger.INFO, ...arguments); }
	error() { this.log(Logger.ERROR, ...arguments); }
	debug() { this.log(Logger.DEBUG, ...arguments); }

	log() {
		let log = this.#process_log(...arguments);
		if (this.#settings.file) this.#log_to_file(log);
		if (this.#settings.stdout && (core.conf["debug"] || log.level !== Logger.DEBUG)) this.#log_to_stdout(log);
		this.emit("log", log);
	}
	log_to_stdout() { 
		this.#log_to_stdout(this.#process_log(...arguments));
	}
	log_to_file() { 
		this.#log_to_file(this.#process_log(...arguments));
	}
	
	/** @param {Log} log */
	#log_to_stdout(log) {
		var message_str = log.toString();
		if (log.level === Logger.WARN) warn.apply(null, [message_str]);
		else if (log.level === Logger.ERROR) error.apply(null, [message_str]);
		else if (log.level === Logger.DEBUG) debug.apply(null, [message_str]);
		else info.apply(null, [message_str]);
	}
	#end() {
		if (!this.#stream) return;
		write_header_line(this.#stream, "END OF LOG");
		this.#stream.end();
		this.#stream = null;
	}
	#start() {
		if (this.#stream) return;
		this.#stream = fs.createWriteStream(this.#filename, {flags:"a"});
		write_header_line(this.#stream, "START OF LOG");
	}
	
	/** @param {Log} log */
	#log_to_file(log) {
		let filename = path.join(core.logs_dir, `${this.name}-${utils.date_to_string(undefined, {time:false})}.log`);
		if (this.#filename != filename) {
			this.#end();
			this.#filename = filename;
			this.#start();
		}
		this.#stream.write(log.toString()+"\n");
	}

	console_adapter() {
		console.log = (...args)=>this.info(...args);
		console.info = (...args)=>this.info(...args);
		console.warn = (...args)=>this.warn(...args);
		console.error = (...args)=>this.error(...args);
		console.debug = (...args)=>this.debug(...args);
	}

	destroy() {
		this.#end();
		this.emit("destroy");
		this.removeAllListeners();
	}

	create_observer() {
		let $ = new utils.Observer();
		let logs = {};
		let _id = 0;
		this.on("destroy", ()=>{
			utils.Observer.destroy($);
		});
		this.on("log", (log)=>{
			let id = ++_id;
			$[id] = log;
			if (!logs[log.level]) logs[log.level] = [];
			logs[log.level].push(id);
			if (logs[log.level].length > core.conf["logs_max_length"]) {
				delete $[logs[log.level].shift()];
			}
		});
		return $;
	}
}

/** @param {import("stream").Writable} stream */
async function write_header_line(stream, str, len=64) {
	var padding = Math.max(0, len - str.length);
	var left = Math.floor(padding/2);
	var right = Math.ceil(padding/2);
	stream.write(`${"-".repeat(left)}${str}${"-".repeat(right)}\n`);
}

module.exports = Logger;

const utils = require("./utils");
const core = require(".");
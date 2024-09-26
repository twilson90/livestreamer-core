import { glob } from "glob";
import path from "node:path";
import chokidar from "chokidar";
import { utils } from "./internal.js";

const __dirname = import.meta.dirname;
var default_conf_paths = [];
default_conf_paths.push(path.resolve(__dirname, "config.default.js"));
var user_conf_paths = [];
if (process.env.LIVESTREAMER_CONF_PATH) {
	user_conf_paths.push(process.env.LIVESTREAMER_CONF_PATH);
} else {
	user_conf_paths.push(...glob.sync("config*"));
}

class ConfigLoader {
	async load() {
		let confs = {};
		let modules = [];
        for (let conf_path of [...default_conf_paths, ...user_conf_paths]) {
            let conf_json = {};
            try {
                conf_json = (await utils.import(conf_path)).default;
				confs[path.resolve(conf_path)] = conf_json;
				modules = conf_json["core.modules"] || modules;
            } catch (e) {
                console.warn(`Conf JSON invalid or missing: ${conf_path}`, e);
            }
        }

		for (let m of modules) {
			let conf_path = path.join(m, "config.default.js");
			try {
				let conf_json = (await utils.import(conf_path)).default;
				default_conf_paths.push(conf_path);
				confs[path.resolve(conf_path)] = conf_json;
			} catch (e) {
				console.error(e);
			}
		}

		let conf = {};
        for (let default_conf_path of [...default_conf_paths]) {
            console.log(`Using default conf: ${default_conf_path}`);
			Object.assign(conf, confs[path.resolve(default_conf_path)]);
		}
        for (let user_conf_path of [...user_conf_paths]) {
            console.log(`Using user conf: ${user_conf_path}`);
			let user_conf = confs[path.resolve(user_conf_path)];
			for (var k in user_conf) {
				if (k in conf) {
					conf[k] = user_conf[k];
				} else {
					console.warn(`Unrecognized conf key: '${k}'`);
				}
			}
		}
		
		return conf;
	}
	watch(cb) {
		var conf_watcher = chokidar.watch([...default_conf_paths, ...user_conf_paths], {awaitWriteFinish:true});
		conf_watcher.on("change", async()=>{
			cb(await this.load());
		});
	}
};
export default ConfigLoader;
const glob = require("glob");
const path = require("node:path");
const chokidar = require("chokidar");

const IS_WINDOWS = (process.platform === "win32");

var conf_paths = ["config.default.js"];
if (process.env.LIVESTREAMER_CONF_PATH) {
	conf_paths.push(process.env.LIVESTREAMER_CONF_PATH);
} else {
	conf_paths.push(...glob.sync(".conf*"));
}

class ConfigLoader {
	load() {
		var conf = {};
        for (var conf_path of conf_paths) {
            console.log(`Applying conf: ${conf_path}`);
            var conf_json = {};
            try {
                conf_json = utils.require(conf_path);
            } catch (e) {
                console.warn(`Conf JSON invalid or missing: ${conf_path}`);
            }
			Object.assign(conf, conf_json);
        }
        if (!conf["appdata_dir"]) {
			if (conf["portable"]) {
				conf["appdata_dir"] = path.resolve(".appdata");
			} else if (IS_WINDOWS) {
            	conf["appdata_dir"] = path.resolve(process.env.PROGRAMDATA, conf["appspace"]);
			} else {
				conf["appdata_dir"] = path.resolve("/var/opt/", conf["appspace"]);
			}
		}
		return conf;
	},
	watch(cb) {
		var conf_watcher = chokidar.watch(conf_paths, {awaitWriteFinish:true});
		conf_watcher.on("change", ()=>{
			cb(this.load());
		});
	}
};
module.exports = ConfigLoader;

const utils = require("./utils");
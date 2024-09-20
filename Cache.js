const path = require("node:path");
const fs = require("fs-extra");
class Cache {
    #cache = {};
    #default_expire = 0;
    #dir;

    constructor(dir, default_expire = 0) {
        this.#dir = path.resolve(core.cache_dir, dir);
        this.#default_expire = default_expire;
        fs.mkdirSync(this.#dir, {recursive:true});
    }

    #get_cache_filename(key) {
        return path.join(this.#dir, key);
    }

    async set(key, data, ttl=null) {
        if (!ttl) ttl = this.#default_expire;
        var d = {data, expires: ttl ? (Date.now() + ttl) : null};
        this.#cache[key] = d;
        var filename = this.#get_cache_filename(key);
        await fs.writeFile(filename, JSON.stringify(d));
    }

    async get(key) {
        let exists = key in this.#cache;
        if (!exists) {
            this.#cache[key] = (async ()=>{
                var filename = this.#get_cache_filename(key);
                var s = await fs.stat(filename).catch(e=>null);
                if (s && s.isFile()) {
                    try {
                        return JSON.parse(await fs.readFile(filename, "utf8"));
                    } catch {
                        core.logger.error(`Failed to load cache file '${filename}'`);
                    }
                }
            })();
        }
        let d = await this.#cache[key];
        if (d) {
            if (!d.expires || d.expires > Date.now()) {
                return d.data;
            }
        }
        return undefined;
    }
}
module.exports = Cache;

const core = require(".");
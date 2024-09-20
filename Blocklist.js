const fs = require("node:fs");
const chokidar = require("chokidar");

/* function handle_input(c) {
    if (typeof c === "string") {
        if (utils.is_valid_ip(c)) c = {ip:c};
        else c = {username:c};
    }
    return c;
} */
class Blocklist {
    $;
    #path;
    #expire_timeouts = {};
    #loading = false;
    #watcher;
    #ignore_changes = false;

    constructor(path) {
        this.#path = path;
		this.$ = new utils.Observer();
        if (!fs.existsSync(this.#path)) this.save();
        utils.Observer.listen(this.$, ()=>{
            if (!this.#loading) this.debounced_save();
        });
        this.reload();
        this.watch();
    }

    // e.g. add({ip:"192.168.0.1"}); add({username:"hedgehog90"},Date.now()+1000*60*60*24*30)
    add(key, expires=0) {
        this.$[key] = expires ? Date.now() + expires : 0;
        if (expires) {
            this.#expire_timeouts[key] = setTimeout(()=>{
                delete this.$[key];
                delete this.#expire_timeouts[key];
            }, expires);
        }
    }

    remove(key) {
        delete this.$[key];
        if (this.#expire_timeouts[key]) {
            clearTimeout(this.#expire_timeouts[key]);
            delete this.#expire_timeouts[key];
        }
    }

    toggle(key) {
        if (key in this.$) this.remove(key);
        else this.add(key);
    }

    is_blocked(key) { return (key in this.$); }

    is_valid(key) { return !this.is_blocked(key); }

    reload() {
        this.#loading = true;
        var json;
        try { json = JSON.parse(fs.readFileSync(this.#path, "utf8")); } catch { }
        var all_keys = new Set(Object.keys(this.$));
        var now = Date.now();
        if (json) {
            for (var k in json) {
                this.add(k, json[k] ? json[k]-now : 0);
                all_keys.delete(k);
            }
        }
        for (var k of all_keys) this.remove(k);
        this.#loading = false;
    }
    
    debounced_save = utils.debounce(this.save, 0);
    save() {
        this.#ignore_changes = true;
        fs.writeFileSync(this.#path, JSON.stringify(this.$, null, "  "), "utf8");
    }

    watch() {
        if (this.#watcher) return;
        this.#watcher = chokidar.watch(this.#path, {awaitWriteFinish:true});
        this.#watcher.on("change", () => {
            if (!this.#ignore_changes) this.reload();
            this.#ignore_changes = false;
        });
    }

    unwatch() {
        if (!this.#watcher) return;
        this.#watcher.close();
        this.#watcher = null;
    }
}

module.exports = Blocklist;

const utils = require("./utils");
const core = require(".");
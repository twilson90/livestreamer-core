const events = require("node:events");

class DataNode extends events.EventEmitter {
    $ = new utils.Observer();
    get id() { return this.$.id; } // always a string

    constructor(id) {
        super();
        if (id == null) id = utils.uuidb64();
        else id = String(id);
        this.$.id = id;
    }
    
    update_values(...datas) {
        var expanded = [];
        for (var data of datas) {
            if (Array.isArray(data)) expanded.push(data);
            else expanded.push(...Object.entries(data));
        }
        for (var [k,v] of expanded) {
            utils.set(this.$, k.split("/"), v);
        }
    }
    
    destroy() {
        // safe to call multiple times.
        utils.Observer.destroy(this.$);
        // this.removeAllListeners();
    }

    toString() {
        return `[${this.constructor.name}:${this.id}]`;
    }
}
module.exports = DataNode;

const utils = require("./utils");
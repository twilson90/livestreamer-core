import { utils } from "./internal.js";
class PropertyCollection {
    __get_defaults() {
        return Object.fromEntries(
            Object.entries(this)
                .filter(([k,prop])=>prop.props || prop.default !== undefined)
                .map(([k,prop])=>[k, this.__get_default(k)])
        );
    }
    __get_default(k) {
        var prop = this[k], def;
        if (prop) {
            if (prop.props && !("default" in prop)) def = prop.props.__get_defaults();
            else def = utils.deep_copy(prop.default);
            return def;
        }
    }
}

export default PropertyCollection;
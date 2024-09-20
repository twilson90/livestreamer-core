const express = require("express");
const events = require("node:events");
const fs = require("fs-extra");
const path = require("node:path");
const fetch = require("node-fetch");

const oauth2_path = "/oauth2";

const DAY = 1000 * 60 * 60 * 24;

/** @typedef {{authorization_uri:string, oauth2_uri:string, client_id:string, client_secret:string, refresh_token_expires_in:Number}} OAuth2Config */

class OAuth2 extends events.EventEmitter {
    /** @param {express.Express} app */
    constructor(app, url) {
        super();
        this.$ = new utils.Observer();
        this.callback_uri = new URL(oauth2_path, url).href;
        this.credentials = {}
        /** @type {Record<string,OAuth2Config>} */
        this.configs = {}
        /** @type {Record<string,NodeJS.Timeout>} */
        this.refresh_token_timeouts = {};

        this.logger = new Logger("oauth2");
        this.logger.on("log", (log)=>core.logger.log(log));

        setInterval(()=>this.refresh_almost_expired(), DAY);

        app.get(oauth2_path, async (req, res, next)=>{
            if (req.query.code && req.query.state) {
                var id = Object.keys(this.configs).find(id=>this.configs[id].state == req.query.state);
                if (id) {
                    await this.authorize(id, req.query.code).catch((err)=>{
                        res.send(`Error: ${err}`);
                        console.error(err);
                    }).then(()=>{
                        res.send("Success")
                    });
                    // res.redirect(oauth2_path);
                    return;
                }
            }
            /* if (req.query.refresh) {
                var id = req.query.refresh;
                if (id) {
                    await this.refresh(id);
                    res.redirect(oauth2_path);
                    return;
                }
            } */
            /* var html = 
`<select></select>
<button id="refresh" onclick="refresh()" title="Refresh Token">↻</button>
<button onclick="submit()">Login</button>
<script>
    var ts = ${Date.now()};
    var configs = ${JSON.stringify(this.configs)};
    var credentials = ${JSON.stringify(this.credentials)};
    var select = document.querySelector("select");
    var url = window.location.origin + window.location.pathname;
    for (var id in configs) {
        var option = document.createElement('option');
        option.value = id;
        var text = credentials[id] ? (ts > credentials[id].expires ? "EXPIRED" : "VALID") : "UNINITIALIZED"
        option.innerHTML = id + " [" + text + "]";
        select.appendChild(option);
    }
    select.onchange = ()=>update();
    function update() {
        document.getElementById("refresh").disabled = credentials[select.value];
    }
    function submit() {
        var id = select.value;
        var o = configs[id];
        window.open(o.authorization_uri, "_self");
    };
    function refresh() {
        var id = select.value;
        window.open(url + '?refresh=' + id, "_self");
    };
</script>`;
            res.send(html); */
        });
    }

    refresh_almost_expired() {
        for (var id in this.credentials) {
            var t = (this.credentials[id].refresh_token_expires || 0) - Date.now()
            if (t < DAY) this.refresh(id);
        }
    }

    /** @param {OAuth2Config} config */
    add_config(id, config) {
        config.id = id;
        config.state = utils.uuidb64();
        this.configs[id] = config;
        
        var url = new URL(config.authorization_uri);
        url.searchParams.append("response_type", "code");
        url.searchParams.append("redirect_uri", this.callback_uri);
        url.searchParams.append("client_id", config.client_id);
        url.searchParams.append("state", config.state);
        if (config.scope) url.searchParams.append("scope", config.scope);
        if (config.layout) url.searchParams.append("layout", config.layout);
        config.authorization_uri = url.toString();

        this.$[id] = config.authorization_uri;

        try {
            this.credentials[id] = JSON.parse(fs.readFileSync(path.join(core.credentials_dir, id)));
        } catch {}
    }

    async authorize(id, code) {
        var config = this.configs[id];
        var response = await fetch(`${config.oauth2_uri}`, {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                'Authorization': 'Basic '+Buffer.from(`${config.client_id}:${config.client_secret}`).toString("base64")
            },
            body: `grant_type=authorization_code&redirect_uri=${this.callback_uri}&code=${code}`
        }).catch(e=>{
            console.error(e);
        });
        if (response.status == 200) {
            this.save_credentials(id, await response.json());
            return response.data;
        }
    }

    async refresh(id) {
        var config = this.configs[id];
        var credentials = this.credentials[id];
        if (!credentials) return;
        var response = await fetch(`${config.oauth2_uri}`, {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                'Authorization': 'Basic '+Buffer.from(`${config.client_id}:${config.client_secret}`).toString("base64")
            },
            body: `grant_type=refresh_token&refresh_token=${credentials.refresh_token}`
        }).catch(e=>{
            console.error(e);
            this.delete_credentials(id);
        });
        if (response.status == 200) {
            var data = await response.json();
            this.save_credentials(id, data);
            return data;
        }
    }

    async access_token(id, force_refresh=false) {
        var credentials = this.credentials[id];
        if (!credentials) return;
        if ((credentials.expires && Date.now() > credentials.expires) || force_refresh) {
            credentials = await this.refresh(id);
        }
        return credentials.access_token;
    }

    // no idea
    /* async request(id, req, refresh_token=false) {
        core.logger.debug(`oauth2 '${id}' request: ${JSON.stringify(req)}`);
        var token = await this.access_token(id, refresh_token);
        if (token) {
            req = {...req};
            req.headers = Object.assign({}, req.headers, {"Authorization": `Bearer ${token}`});
            var res = await axios.request(req).catch((err)=>{
                core.logger.error(err);
            });
            if (res.status == 200) {
                return res.data;
            } else if (res.status == 401 && res.data.error.name === "invalid_token") {
                core.logger.info("oauth2 401 invalid_token, refreshing...");
                if (!refresh_token) {
                    return this.request(id, req, true);
                }
            }
        } else {
            core.logger.error(`Token is undefined.`);
        }
    } */

    delete_credentials(id) {
        delete this.credentials[id];
        try { fs.unlinkSync(path.join(core.credentials_dir, id)); } catch {}
    }

    save_credentials(id, creds) {
        creds.expires = Date.now() + (creds.expires_in || creds.accessTokenExpiresIn) * 1000;
        creds.refresh_token_expires = Date.now() + (creds.refresh_token_expires_in || creds.refreshTokenExpiresIn || this.configs[id].refresh_token_expires_in || 31536000) * 1000;
        this.credentials[id] = creds;
        fs.writeFileSync(path.join(core.credentials_dir, id), JSON.stringify(creds, null, "  "));
        this.emit("update", id, creds);
    }
}

module.exports = OAuth2;

const core = require(".");
const utils = require("./utils");
const Logger = require("./Logger");
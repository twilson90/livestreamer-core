const conf = require("./config.default.js")
// if (!process.env.LIVESTREAMER_DOCKER) load_env("./env.default.js")
// load_env("./.env.js") || load_env("./.env.json") || load_env("./.env");

module.exports = {
  apps: [
    {
      script: "./index.js",
      name: conf["appspace"],
      cron_restart: conf["cron_restart"],
      node_args: conf["debug"] ? `--inspect=${conf["inspect"] || "0.0.0.0:9229"}`: "",
    },
  ],
};
module.exports = {
	"appspace": process.env.LIVESTREAMER_APPSPACE || "livestreamer",
	"appdata_dir": process.env.LIVESTREAMER_APPDATA_DIR || "",
	"portable": !!process.env.LIVESTREAMER_PORTABLE || false,
	"cron_restart": process.env.LIVESTREAMER_CRON_RESTART || "",
	"inspect": process.env.LIVESTREAMER_INSPECT || "0.0.0.0:9229",
	"debug": process.env.LIVESTREAMER_DEBUG || false,
	
	"hostname": "localhost",
	"logs_max_length": 64,
	"logs_max_msg_length": 128 * 1024, // 128 kb
	"ssl_key": "",
	"ssl_cert": "",
	"compress_logs_schedule": "* 4 * * *", // Every day @ 4:00 am
	"http_port": 8120,
	"https_port": 8121,
	"authenticator": null,
	
	"mpv_executable": "mpv",
	"mpv_hwdec": null,
	"mpv_hwenc": null,
	"ffmpeg_executable": "ffmpeg",
	"ffmpeg_hwaccel": null,
	"ffmpeg_hwenc": null,
}
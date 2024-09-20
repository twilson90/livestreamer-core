const fs = require("fs-extra");
const path = require("node:path");
const tar = require("tar");
const uuid = require("uuid");
const is_image = require("is-image");
const execa = require("execa");
const parse = require("shell-quote/parse");

const utils = {
    
    ...require("@hedgehog90/utils"),

    require(require_path) {
        try { require_path = require.resolve(require_path); } catch { require_path = path.resolve(require_path); }
        delete require.cache[require_path];
        return require(require_path);
    },

    /** @param {string} file @param {readonly string[]?} params @param {execa.Options?} opts */
    exec(file, params, opts) {
        opts = {...opts};
        if (typeof params === "string") params = parse(params);
        if (opts.wsl) {
            delete opts.wsl;
            params.unshift(file);
            file = "wsl";
            let quote = (s)=>`'${s.replace(/'/g, `"'"`)}'`;
            params = params.map(s=>quote(s));
        }
        return execa(file, params, opts);
    },

    async read_last_lines(input_file_path, max_lines, encoding, buffer_size) {
        buffer_size = buffer_size || 16 * 1024;
        const nl = "\n".charCodeAt(0);
        var [stat, file] = await Promise.all([
            fs.stat(input_file_path),
            fs.open(input_file_path, "r")
        ]);
        let lines = [];
        var chunk = Buffer.alloc(buffer_size);
        let leftover = [];
        var add_line = (buffer)=>{
            lines.push(encoding ? buffer.toString(encoding) : buffer);
        }
        let pos = stat.size;
        while (pos) {
            pos -= buffer_size
            if (pos < 0) {
                buffer_size += pos;
                pos = 0;
            }
            await fs.read(file, chunk, 0, buffer_size, pos);
            let i = buffer_size;
            let last_nl_index = buffer_size;
            while (i--) {
                if (chunk[i] === nl) {
                    let temp = chunk.subarray(i+1, last_nl_index);
                    if (leftover.length) {
                        temp = Buffer.from([...temp, ...leftover]);
                        leftover = [];
                    }
                    add_line(temp);
                    last_nl_index = i;
                    if (lines.length >= max_lines) break;
                }
            }
            if (lines.length >= max_lines) break;
            leftover = Buffer.from([...chunk.subarray(0, last_nl_index), ...leftover]);
            if (pos == 0) {
                add_line(leftover);
            }
        }
        lines.reverse();
        await fs.close(file);
        return lines;
    },
    
    is_image(filepath) {
        return is_image(filepath || "");
    },

    async is_dir_empty(p) {
        try {
            const directory = await fs.opendir(p);
            const entry = await directory.read();
            await directory.close();
            return entry === null;
        } catch (error) {
            return false;
        }
    },
    
    async reserve_disk_space(filepath, size) {
        let fd = await fs.open(filepath, "w");
        await fs.write(fd, "\0", size-1);
        await fs.close(fd);
    },
    
    async unique_filename(filepath) {
        let n = 0;
        let ext = path.extname(filepath);
        let filename = path.basename(filepath, ext);
        let dir = path.dirname(filepath);
        while (true) {
            let stat = await fs.stat(filepath).catch(()=>{});
            if (!stat) return filepath;
            let suffix = (n == 0) ? ` - Copy` : ` - Copy (${n+1})`;
            filepath = path.join(dir, filename + suffix + ext);
            n++;
        }
    },

    async readdir_stats(dir){
        var files = await fs.promises.readdir(dir);
        return Promise.all(files.map(filename=>fs.promises.lstat(path.join(dir, filename)).then(stat=>({filename,stat}))));
    },
    
    async get_most_recent_file_in_dir(dir){
        var files = await fs.promises.readdir(dir);
        return (await utils.order_files_by_mtime(files, dir)).pop();
    },
    
    async order_files_by_mtime(files, dir){
        var stat_map = {};
        await Promise.all(files.map((filename)=>(async()=>{
            var fullpath = dir ? path.join(dir, filename) : filename;
            stat_map[filename] = await fs.promises.lstat(fullpath);
        })()));
        return files
            .map(filename=>({filename, stat:stat_map[filename]}))
            .filter(f=>f.stat.isFile())
            .sort((a,b)=>a.stat.mtime-b.stat.mtime)
            .map(f=>f.filename);
    },

    uuidb64() {
        return Buffer.from(uuid.v4().replace(/-/g, '')).toString("base64url");
    },
    
    async order_files_by_mtime_descending(files, dir){
        return (await utils.order_files_by_mtime(files, dir)).reverse();
    },
    
    split_spaces_exclude_quotes(string) {
        let match, matches = [];
        const groupsRegex = /[^\s"']+|(?:"|'){2,}|"(?!")([^"]*)"|'(?!')([^']*)'|"|'/g;
        while ((match = groupsRegex.exec(string))) {
            if (match[2]) {
                matches.push(match[2]);
            } else if (match[1]) {
                matches.push(match[1]);
            } else {
                matches.push(match[0]);
            }
        }
        return matches;
    },
    
    has_root_privileges(){
        return !!(process.getuid && process.getuid() === 0);
    },
    
    async compress_logs_directory(dir){
        var now = Date.now();
        // core.logger.info(`Compressing '${dir}'...`);
        var dayago = now - (24 * 60 * 60 * 1000);
        var promises = [];
        var files = await fs.readdir(dir);
        files = files.filter(filename=>filename.match(/\.log$/));
        files = await utils.order_files_by_mtime_descending(files, dir);
        for (let filename of files) {
            let fullpath = path.join(dir, filename);
            let stats = await fs.lstat(fullpath);
            let tar_path = `${fullpath}.tgz`;
            if (+stats.mtime < dayago) {
                var t = Date.now();
                promises.push(
                    (async()=>{
                        await tar.create({gzip:true, file:tar_path, cwd:dir, portable:true}, [filename]).catch(()=>{});
                        // core.logger.info(`Compressed '${fullpath}' in ${Date.now()-t}ms.`);
                        await fs.utimes(tar_path, stats.atime, stats.mtime);
                        await fs.unlink(fullpath);
                    })()
                );
            }
        }
        await Promise.all(promises);
        // core.logger.info(`Compression of '${dir}' took ${Date.now()-now}ms.`)
    },
    
};

module.exports = utils;
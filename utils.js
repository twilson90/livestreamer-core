import fs from "fs-extra";
import path from "node:path";
import * as tar from "tar";
import * as uuid from "uuid";
import is_image from "is-image";
import { execa } from "execa";
import file_url from "file-url";
import { createRequire } from "module";
import child_process, { ChildProcess } from "node:child_process";

const node_require = createRequire(import.meta.url);

import * as utils from "@hedgehog90/utils";

export * from "@hedgehog90/utils";
export * from "node:util";

export function is_windows() { return process.platform === "win32"; }

async function _import(p, o) { return import(file_url(p), o); }
export { _import as import }

export function require(require_path) {
    try { require_path = node_require.resolve(require_path); } catch { require_path = path.resolve(require_path); }
    delete node_require.cache[require_path];
    return node_require(require_path);
}

export { execa }

//command: string, args: ReadonlyArray<string>, options: SpawnOptions
// /** @param {string} command @param {readonly string[]} args @param {child_process.SpawnOptions} options */
// export function spawn(command, args, options) {
//     options = {windowsHide:true, ...options };
//     try {
//         return child_process.spawn(command, args, options);
//     } catch (e) {
//         console.error(e);
//     }
// }

export async function read_last_lines(input_file_path, max_lines, encoding, buffer_size) {
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
}

export {is_image};

export async function is_dir_empty(p) {
    try {
        const directory = await fs.opendir(p);
        const entry = await directory.read();
        await directory.close();
        return entry === null;
    } catch (error) {
        return false;
    }
}

export async function reserve_disk_space(filepath, size) {
    let fd = await fs.open(filepath, "w");
    await fs.write(fd, "\0", size-1);
    await fs.close(fd);
}

export async function unique_filename(filepath) {
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
}

export async function readdir_stats(dir){
    var files = await fs.promises.readdir(dir);
    return Promise.all(files.map(filename=>fs.promises.lstat(path.join(dir, filename)).then(stat=>({filename,stat}))));
}

export async function get_most_recent_file_in_dir(dir){
    var files = await fs.promises.readdir(dir);
    return (await order_files_by_mtime(files, dir)).pop();
}

export async function order_files_by_mtime(files, dir){
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
}

export function uuidb64() {
    return Buffer.from(uuid.v4().replace(/-/g, '')).toString("base64url");
}

export function uuid4() {
    return uuid.v4();
}

export async function order_files_by_mtime_descending(files, dir){
    return (await order_files_by_mtime(files, dir)).reverse();
}

export function split_spaces_exclude_quotes(string) {
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
}

export function has_root_privileges(){
    return !!(process.getuid && process.getuid() === 0);
}

export async function  compress_logs_directory(dir){
    var now = Date.now();
    // core.logger.info(`Compressing '${dir}'...`);
    var dayago = now - (24 * 60 * 60 * 1000);
    var promises = [];
    var files = await fs.readdir(dir);
    files = files.filter(filename=>filename.match(/\.log$/));
    files = await order_files_by_mtime_descending(files, dir);
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
}

export async function tree_kill(pid, signal) {
    pid = parseInt(pid);
    if (Number.isNaN(pid)) {
        throw new Error("pid must be a number");
    }
    if (process.platform === "win32") {
        return new Promise(resolve=>child_process.exec(`taskkill /pid ${pid} /T /F`, { windowsHide: true }, resolve));
    }
    var killed = {};
    /** @type {Object<string,number[]>} */
    var tree = {};
    var pids_to_process = {[pid]:1};
    function kill(pid, signal) {
        if (!killed[pid]) return;
        killed[pid] = 1;
        try {
            process.kill(parseInt(pid, 10), signal);
        } catch (err) {
            if (err.code !== 'ESRCH') throw err;
        }
    }
    async function build_process_tree(parent_pid) {
        var ps;
        if (process.platform === "darwin") {
            ps = child_process.spawn('pgrep', ['-P', parent_pid]);
        } else {
            ps = child_process.spawn('ps', ['-o', 'pid', '--no-headers', '--ppid', parent_pid]);
        }
        var all_data = '';
        ps.stdout.on('data', (data)=>{
            all_data += data.toString('ascii');
        });
        let code = new Promise(resolve=>ps.on('close', resolve));
        delete pids_to_process[parent_pid];
        if (code != 0) return;
        await Promise.all(all_data.match(/\d+/g).map(pid=>{
            pid = parseInt(pid, 10);
            if (!tree[parent_pid]) tree[parent_pid] = [];
            tree[parent_pid].push(pid);
            pids_to_process[pid] = 1;
            return build_process_tree(pid);
        }))
    }
    await build_process_tree(pid);
    for (let pid in tree) {
        for (let pidpid of tree[pid]) kill(pidpid, signal);
        kill(pid, signal);
    }
}
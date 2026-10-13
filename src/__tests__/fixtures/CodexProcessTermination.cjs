// Only synthetic processes: no Codex configuration, credentials, or model traffic.
const {spawn} = require("node:child_process");
const {writeFileSync, existsSync} = require("node:fs");

let [role, directory, mode] = process.argv.slice(2);
if (role === "app-server") {
    role = "stdio";
    directory = process.env.CODEX_PROCESS_TERMINATION_FIXTURE_DIR;
}
const write = (name, value) => writeFileSync(`${directory}/${name}`, String(value));
if (role === "stdio") {
    process.stdin.resume();
    process.stdin.on("data", data => process.stdout.write(data));
    process.stdin.on("end", () => {
        process.stderr.write("fixture EOF\n", () => process.exit(17));
    });
    process.on("SIGTERM", () => {
        process.stderr.write("fixture SIGTERM\n", () => process.exit(29));
    });
    write("ready", process.pid);
    setTimeout(() => process.exit(99), 30_000).unref();
} else if (role === "child") {
    process.on("SIGTERM", () => {});
    write("child.pid", process.pid);
    // A safety lease bounds the lifetime even if a test crashes before cleanup.
    const lease = setTimeout(() => process.exit(0), 30_000);
    const heartbeat = setInterval(() => {
        if (existsSync(`${directory}/cleanup`)) {
            clearInterval(heartbeat);
            clearTimeout(lease);
            process.exit(0);
        }
        write("heartbeat", Date.now());
    }, 25);
} else {
    process.on("SIGTERM", () => {});
    const childArgs = typeof Bun !== "undefined" && Bun.main.startsWith("/$bunfs/")
        ? ["child", directory, mode] : [__filename, "child", directory, mode];
    const child = spawn(process.execPath, childArgs, {stdio: "inherit"});
    child.on("error", () => process.exit(1));
    write("parent.pid", process.pid);
    setTimeout(() => process.exit(0), 30_000);
    setInterval(() => {
        if (existsSync(`${directory}/exit-parent`)) process.exit(23);
        if (existsSync(`${directory}/signal-parent`)) process.kill(process.pid, "SIGKILL");
        if (existsSync(`${directory}/cleanup`)) process.exit(0);
    }, 25);
}

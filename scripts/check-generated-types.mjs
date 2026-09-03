import {execFileSync} from "node:child_process";

const status = execFileSync(
    "git",
    ["status", "--porcelain", "--untracked-files=all", "--", "src/app-server"],
    {encoding: "utf8"},
);

if (status.length > 0) {
    process.stderr.write(status);
    process.stderr.write("Generated app-server types are not up to date.\n");
    process.exitCode = 1;
}

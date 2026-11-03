export function stripShellPrefix(command: string): string {
    const shell = /^(?:\/(?:[^\s/]+\/)*)?(?:bash|zsh|sh)\s+(?:-[lc]+\s+)?/.exec(command);
    if (!shell) return command;
    const withoutShell = command.slice(shell[0].length);
    // Keep invocations with shell options that this display cleanup does not recognize.
    if (withoutShell.startsWith("-")) return command;
    if (/^'[^']*'$/.test(withoutShell)) {
        return withoutShell.slice(1, -1);
    }
    if (/^"(?:[^"\\]|\\[\s\S])*"$/.test(withoutShell)) {
        return withoutShell.slice(1, -1).replace(/\\([$`"\\\n])/g,
            (_escape, character: string) => character === "\n" ? "" : character);
    }
    return withoutShell;
}

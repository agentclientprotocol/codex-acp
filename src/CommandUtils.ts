export function stripShellPrefix(command: string): string {
    const withoutShell = command.replace(/^(?:\/bin\/)?(?:bash|zsh|sh)\s+(?:-[lc]+\s+)?/, "");
    if (withoutShell.startsWith("'") && withoutShell.endsWith("'")) {
        return withoutShell.slice(1, -1);
    }
    return withoutShell;
}

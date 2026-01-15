import fs from "node:fs";
import path from "node:path";

interface LogContext {
    [key: string]: unknown;
}

class Logger {
    private readonly logFilePath: string | null;

    constructor() {
        const logDir = process.env["APP_SERVER_LOGS"];
        if (!logDir) {
            this.logFilePath = null;
            return;
        }

        try {
            fs.mkdirSync(logDir, {recursive: true});
            this.logFilePath = path.join(logDir, "app-server.log");
        } catch (ex) {
            console.error("Failed to initialize logger directory", ex);
            this.logFilePath = null;
        }
    }

    error(message: string, err: unknown) {
        this.log(`[SYSTEM_ERROR] ${message}`, {exception: this.formatError(err)});
    }

    log(message: string, context?: LogContext) {
        if (!this.logFilePath) return;
        try {
            const timestamp = this.formatTimestamp(new Date());
            const serializedContext = context ? ` ${JSON.stringify(context)}` : "";

            if (!message.startsWith('[')) message = `[SYS] ${message}`;
            const line = `${timestamp} ${message}${serializedContext}`;
            fs.appendFileSync(this.logFilePath, `${line}\n`);
        } catch (ex) {
            console.error("Logger write failed", ex);
        }
    }

    private formatTimestamp(date: Date): string {
        const yyyy = date.getFullYear();
        const mm = String(date.getMonth() + 1).padStart(2, "0");
        const dd = String(date.getDate()).padStart(2, "0");
        const hh = String(date.getHours()).padStart(2, "0");
        const min = String(date.getMinutes()).padStart(2, "0");
        const ss = String(date.getSeconds()).padStart(2, "0");
        const ms = String(date.getMilliseconds()).padStart(3, "0");
        return `${yyyy}-${mm}-${dd} ${hh}:${min}:${ss},${ms}`;
    }

    private formatError(err: unknown): string {
        if (err instanceof Error) {
            const parts = [`${err.name}: ${err.message}`];
            if (err.stack) {
                parts.push(err.stack);
            }
            if ("cause" in err && err.cause) {
                parts.push(`Caused by: ${this.formatError(err.cause as unknown)}`);
            }
            return parts.join("\n");
        }

        if (typeof err === "string") {
            return err;
        }

        return String(err);
    }
}

export const logger = new Logger();

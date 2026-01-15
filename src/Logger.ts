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

    log(message: string, context?: LogContext) {
        if (!this.logFilePath) return;
        try {
            const timestamp = new Date().toISOString();
            const serializedContext = context ? ` ${JSON.stringify(context)}` : "";

            if (!message.startsWith('[')) message = `[SYS] ${message}`;
            const line = `[${timestamp}] ${message}${serializedContext}`;
            fs.appendFileSync(this.logFilePath, `${line}\n`);
        } catch (ex) {
            console.error("Logger write failed", ex);
        }
    }
}

export const logger = new Logger();

import path from "node:path";
import type {
    FuzzyFileSearchSessionCompletedNotification,
    FuzzyFileSearchSessionUpdatedNotification,
} from "../../app-server";
import type {ToolFacts} from "../ToolFacts";
import {searchTitle} from "./CommandReporter";

/** Reports a Codex fuzzy file search session. The found files are the locations. */
export class FuzzySearchReporter {
    private readonly activeSessions = new Set<string>();

    updated(event: FuzzyFileSearchSessionUpdatedNotification): ToolFacts {
        const toolCallId = fuzzyFileSearchToolCallId(event.sessionId);
        const started = !this.activeSessions.has(toolCallId);
        this.activeSessions.add(toolCallId);
        const facts: ToolFacts = {
            toolCallId,
            report: started ? "start" : "update",
            title: searchTitle(event.query, null),
            status: "in_progress",
            locations: event.files.map(file => path.isAbsolute(file.path) ? file.path : path.join(file.root, file.path)),
        };
        return started ? {...facts, kind: "search", input: {query: event.query}} : facts;
    }

    completed(event: FuzzyFileSearchSessionCompletedNotification): ToolFacts {
        const toolCallId = fuzzyFileSearchToolCallId(event.sessionId);
        this.activeSessions.delete(toolCallId);
        return {toolCallId, report: "update", status: "completed"};
    }
}

export function fuzzyFileSearchToolCallId(sessionId: string): string {
    return `fuzzyFileSearch.${sessionId}`;
}

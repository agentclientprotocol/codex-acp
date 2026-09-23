import type {ThreadItem} from "../../app-server/v2";
import type {ToolFacts} from "../ToolFacts";

type WebSearchItem = ThreadItem & {type: "webSearch"};

/** Reports a Codex web search. */
export class WebSearchReporter {
    static started(item: WebSearchItem): ToolFacts {
        return {...facts(item, "start"), kind: "search", status: "in_progress"};
    }

    static completed(item: WebSearchItem): ToolFacts {
        return {...facts(item, "update"), status: "completed"};
    }

    /** The replay of a web search. Every client gets the same `rawInput`. */
    static history(item: WebSearchItem): ToolFacts {
        const {standard: _standard, ...replayed} = facts(item, "start");
        return {...replayed, kind: "search", status: "completed"};
    }
}

function facts(item: WebSearchItem, report: ToolFacts["report"]): ToolFacts {
    return {
        toolCallId: item.id,
        report,
        title: webSearchTitle(item),
        input: {query: item.query, action: item.action},
        // A live report of a client that is not AIR also names the item.
        standard: {rawInput: {type: item.type, id: item.id, query: item.query, action: item.action}},
    };
}

export function webSearchTitle(item: WebSearchItem): string {
    const action = item.action;
    if (!action) {
        return item.query ? `Web search: ${item.query}` : "Web search";
    }
    switch (action.type) {
        case "search": {
            const queries = action.queries?.filter((query) => query && query.length > 0) ?? [];
            const query = action.query ?? (queries.length > 0 ? queries.join(", ") : null) ?? item.query;
            return query ? `Web search: ${query}` : "Web search";
        }
        case "openPage":
            return action.url ? `Open page: ${action.url}` : "Open page";
        case "findInPage": {
            const pattern = action.pattern ? ` for '${action.pattern}'` : "";
            const url = action.url ? ` in ${action.url}` : "";
            return `Find in page${pattern}${url}`.trim();
        }
        case "other":
            return "Web search";
    }
}

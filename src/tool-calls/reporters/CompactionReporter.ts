import type {ThreadItem} from "../../app-server/v2";
import {createContextCompactionMetadata} from "../../ContextCompactionMeta";
import type {ToolFacts} from "../ToolFacts";

type ContextCompactionItem = ThreadItem & {type: "contextCompaction"};

const TITLE = "Compact conversation";

/** Reports a Codex context compaction as a tool call, for a client without ACP compaction updates. */
export class CompactionReporter {
    static started(item: ContextCompactionItem): ToolFacts {
        return {...facts(item, "start"), kind: "think", status: "in_progress"};
    }

    static completed(item: ContextCompactionItem): ToolFacts {
        return {...facts(item, "update"), status: "completed"};
    }

    static history(item: ContextCompactionItem): ToolFacts {
        return {...facts(item, "start"), kind: "think", status: "completed"};
    }
}

function facts(item: ContextCompactionItem, report: ToolFacts["report"]): ToolFacts {
    return {toolCallId: item.id, report, title: TITLE, contextCompaction: createContextCompactionMetadata()};
}

import {CommandReporter} from "./tool-calls/reporters/CommandReporter";
import {FuzzySearchReporter} from "./tool-calls/reporters/FuzzySearchReporter";
import {GuardianReporter} from "./tool-calls/reporters/GuardianReporter";

/** Item presentation state that standard children retain across parent handler changes. */
export class CodexItemStreamState {
    readonly commands = new CommandReporter();
    readonly fuzzySearches = new FuzzySearchReporter();
    readonly guardianReviews = new GuardianReporter();
    readonly activeImageGenerationItems = new Set<string>();
    readonly emittedImageViewItems = new Set<string>();
    readonly seenReasoningDeltaItemIds = new Set<string>();
    readonly agentMessagePhases = new Map<string, string | null>();
}

import {z} from "zod";
export const SESSION_ARCHIVE_METHOD = "_session/archive";
export const SESSION_UNARCHIVE_METHOD = "_session/unarchive";
export const sessionArchiveParser = z.object({sessionId: z.string().trim().min(1)}).strict();
export function archiveCapability() {
    return {version: 1, archiveMethod: SESSION_ARCHIVE_METHOD, unarchiveMethod: SESSION_UNARCHIVE_METHOD, permanentDelete: false};
}

import type {JsonValue} from "./app-server/serde_json/JsonValue";
import type {SkillsListResponse} from "./app-server/v2";

/**
 * Skills that ACP clients cannot use.
 *
 * Codex's bundled Visualize skill ends a reply with a content reference that only the OpenAI apps render,
 * so ACP clients show it as raw `visualize{...}` text.
 *
 * Skills are matched by their plugin-qualified name, so that a session needs no `skills/list` lookup. A skill of
 * another plugin with the same name, such as a `visualize` skill in some other `visualize` plugin, is disabled too.
 */
const UNSUPPORTED_SKILL_NAMES: ReadonlySet<string> = new Set(["visualize:visualize"]);

type JsonObject = { [key in string]?: JsonValue };

/** Adds the rules that disable the unsupported skills to a thread config. */
export function disableUnsupportedSkills(config: JsonObject): JsonObject {
    const skills = isJsonObject(config["skills"]) ? config["skills"] : {};
    const rules = Array.isArray(skills["config"]) ? skills["config"] : [];
    return {
        ...config,
        skills: {
            ...skills,
            // Last, because Codex lets a later rule for the same selector replace an earlier one.
            config: [...rules, ...Array.from(UNSUPPORTED_SKILL_NAMES, name => ({name, enabled: false}))],
        },
    };
}

/** Removes the unsupported skills from a `skills/list` response. */
export function withoutUnsupportedSkills(response: SkillsListResponse): SkillsListResponse {
    return {
        ...response,
        data: response.data.map(entry => ({
            ...entry,
            skills: entry.skills.filter(skill => !UNSUPPORTED_SKILL_NAMES.has(skill.name)),
        })),
    };
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

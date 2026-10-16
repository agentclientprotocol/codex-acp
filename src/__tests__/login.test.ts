import {describe, expect, it} from "vitest";

import {resolveLoginCodexPath} from "../login";

describe("resolveLoginCodexPath", () => {
    it("uses the bundled Codex app-server when CODEX_PATH is absent", () => {
        expect(resolveLoginCodexPath({})).toBeUndefined();
    });

    it("preserves an explicit CODEX_PATH override", () => {
        expect(resolveLoginCodexPath({CODEX_PATH: "/opt/codex/bin/codex"})).toBe("/opt/codex/bin/codex");
    });
});

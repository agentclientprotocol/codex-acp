import {describe, expect, it} from "vitest";
import {createTestFixture, createObjectDump} from "./acp-test-utils";

describe("createObjectDump anonymizer", () => {
    it("anonymizes both direct keys and dotted paths", () => {
        const payload = {
            id: "123",
            meta: {
                token: "secret-token",
                nested: {
                    token: "deep-secret",
                },
            },
            items: [
                {secret: "first-item", visible: "keep"},
                {secret: "second-item"},
            ],
        };

        const dump = createObjectDump(payload, [
            "id",
            "meta.token",
            "meta.nested.token",
            "items.0.secret",
        ]);
        const parsed = JSON.parse(dump);

        expect(parsed.id).toBe("id");
        expect(parsed.meta.token).toBe("token");
        expect(parsed.meta.nested.token).toBe("token");
        expect(parsed.items[0].secret).toBe("secret");
        expect(parsed.items[0].visible).toBe("keep");
        expect(parsed.items[1].secret).toBe("second-item");
    });
});


describe("native fixture cleanup", () => {
    let previous: ReturnType<typeof createTestFixture>;
    it("owns a running app-server for the current test", async () => {
        previous = createTestFixture();
        await previous.getCodexAcpAgent().initialize({protocolVersion: 1});
        expect(previous.getCodexAcpAgent()["getExitCode"]()).toBeNull();
    });
    it("does not leave the preceding test app-server alive", () => {
        expect(previous.getCodexAcpAgent()["getExitCode"]()).not.toBeNull();
    });
});

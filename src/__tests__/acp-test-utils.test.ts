import {describe, expect, it} from "vitest";
import {createObjectDump} from "./acp-test-utils";

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

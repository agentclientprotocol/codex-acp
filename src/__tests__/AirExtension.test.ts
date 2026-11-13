import {describe, expect, it} from "vitest";
import {AIR_DIFF_PATCH_KEY, clientSupportsAirCapability} from "../AirExtension";

describe("clientSupportsAirCapability", () => {
    const air = (value: unknown) => ({_meta: {jetbrains: {air: value}}});

    it("accepts the diff patch capability only with a valid AIR declaration", () => {
        expect(clientSupportsAirCapability(air({version: 1, capabilities: [AIR_DIFF_PATCH_KEY]}), AIR_DIFF_PATCH_KEY)).toBe(true);
        expect(clientSupportsAirCapability(null, AIR_DIFF_PATCH_KEY)).toBe(false);
        expect(clientSupportsAirCapability({}, AIR_DIFF_PATCH_KEY)).toBe(false);
        expect(clientSupportsAirCapability(air({version: 1, capabilities: []}), AIR_DIFF_PATCH_KEY)).toBe(false);
        expect(clientSupportsAirCapability(air({version: 0, capabilities: [AIR_DIFF_PATCH_KEY]}), AIR_DIFF_PATCH_KEY)).toBe(false);
        expect(clientSupportsAirCapability(air({version: "1", capabilities: [AIR_DIFF_PATCH_KEY]}), AIR_DIFF_PATCH_KEY)).toBe(false);
        expect(clientSupportsAirCapability(air({version: 1.5, capabilities: [AIR_DIFF_PATCH_KEY]}), AIR_DIFF_PATCH_KEY)).toBe(false);
    });
});

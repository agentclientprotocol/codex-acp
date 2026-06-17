import { describe, expect, it } from "vitest";
import { resolveTerminalOutputMode } from "../TerminalOutputMode";

describe("resolveTerminalOutputMode", () => {
    it("uses terminal_output when advertised", () => {
        expect(resolveTerminalOutputMode({
            _meta: {
                terminal_output: true,
                terminal_output_delta: true,
            },
        })).toBe("terminal_output");
    });

    it("uses legacy terminal_output_delta when only it is advertised", () => {
        expect(resolveTerminalOutputMode({
            _meta: {
                terminal_output_delta: true,
            },
        })).toBe("terminal_output_delta");
    });

    it("keeps legacy terminal_output_delta when capabilities are absent", () => {
        expect(resolveTerminalOutputMode(null)).toBe("terminal_output_delta");
        expect(resolveTerminalOutputMode({})).toBe("terminal_output_delta");
    });
});

import { describe, expect, it } from "vitest";
import { resolveTerminalOutputMode } from "../TerminalOutputMode";

describe("resolveTerminalOutputMode", () => {
    it("prefers terminal_output_delta when both modes are advertised", () => {
        expect(resolveTerminalOutputMode({
            _meta: {
                terminal_output: true,
                terminal_output_delta: true,
            },
        })).toBe("terminal_output_delta");
    });

    it("uses legacy terminal_output_delta when only it is advertised", () => {
        expect(resolveTerminalOutputMode({
            _meta: {
                terminal_output_delta: true,
            },
        })).toBe("terminal_output_delta");
    });

    it("uses terminal_output when it is the only advertised mode", () => {
        expect(resolveTerminalOutputMode({
            _meta: {
                terminal_output: true,
            },
        })).toBe("terminal_output");
    });

    it("keeps legacy terminal_output_delta when capabilities are absent", () => {
        expect(resolveTerminalOutputMode(null)).toBe("terminal_output_delta");
        expect(resolveTerminalOutputMode({})).toBe("terminal_output_delta");
    });
});

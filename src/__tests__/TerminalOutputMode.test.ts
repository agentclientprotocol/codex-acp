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

    // Portable output is the default when no terminal extension is advertised.
    it("uses portable content when terminal extensions are absent", () => {
        expect(resolveTerminalOutputMode(null)).toBe("content");
        expect(resolveTerminalOutputMode({})).toBe("content");
    });
});

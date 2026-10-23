import {describe, expect, it} from "vitest";
import {CrashLoopGuard} from "../../app-server-recovery/CrashLoopGuard";

describe("CrashLoopGuard", () => {
    it("trips at the limit and opens when the oldest crash leaves the window", () => {
        let now = 0;
        const guard = new CrashLoopGuard(3, 1000, () => now);
        guard.record(); now = 100;
        guard.record(); now = 200;
        expect(guard.tripped()).toBe(false);
        guard.record();
        expect(guard.tripped()).toBe(true);
        expect(guard.retryAfterMs()).toBe(800);
        now = 1001;
        expect(guard.tripped()).toBe(false);
        expect(guard.count()).toBe(2);
        expect(guard.lastCrashAt()).toBe(200);
    });

    it("counts each key on its own", () => {
        const guard = new CrashLoopGuard(2, 1000, () => 0);
        guard.record("a");
        guard.record("a");
        guard.record("b");
        expect(guard.tripped("a")).toBe(true);
        expect(guard.tripped("b")).toBe(false);
        expect(guard.tripped()).toBe(false);
    });
});

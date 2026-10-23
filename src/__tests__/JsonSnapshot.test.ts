import {describe, expect, it} from "vitest";
import {JsonObject, jsonSnapshot, jsonText, sameJson, type JsonTree} from "../JsonSnapshot";

/** The text of a snapshot, like `JSON.stringify` of the value. */
function text(tree: JsonTree | undefined): string | undefined {
    return tree === undefined ? undefined : jsonText(tree);
}

/** The comparison that `ToolCallReports` made before snapshots: the serialized texts. */
function sameText(value: unknown, recorded: unknown): boolean {
    return JSON.stringify(value) === JSON.stringify(recorded);
}

function nested(depth: number, leaf: unknown): unknown {
    let value = leaf;
    for (let level = 0; level < depth; level++) value = level % 2 === 0 ? {next: value} : [value];
    return value;
}

class Box {
    constructor(readonly value: number) {}
}

const nullPrototype = Object.assign(Object.create(null) as Record<string, unknown>, {a: 1});
const ownProto = JSON.parse('{"__proto__": {"x": 1}, "a": 1}') as unknown;
const sparse = [1, , 3];
const functionWithToJson = Object.assign(() => 1, {toJSON: () => 1});
const keyEcho = {toJSON: (key: string) => `key:${key}`};
const overriddenCall = Object.assign(() => 2, {call: () => 1});
const proxied = new Proxy({"1": "a", "2": "b"}, {ownKeys: () => ["2", "1"]});
const rawJson = (JSON as {rawJSON?: (text: string) => unknown}).rawJSON;

/** Values with the edge cases of `JSON.stringify`, each compared with every other value and with itself. */
const VALUES: unknown[] = [
    null, true, false, 0, -0, 1, 1.5, NaN, Infinity, -Infinity, "", "a", "b", "0", "null", "\"a\"", "\n", " ", "\ud800",
    [], [null], [undefined], [() => 1], [Symbol("s")], [NaN], sparse, [1, null, 3], [1, 2, 3], [1, 2], [[1], 2], ["a", "b"], ["b", "a"],
    {}, {a: 1}, {a: "1"}, {a: undefined}, {a: () => 1}, {a: Symbol("s")}, {a: 1, b: undefined}, {b: 1}, {a: 1, b: 2}, {b: 2, a: 1},
    {a: {b: [1, {c: "x"}]}}, {a: {b: [1, {c: "y"}]}}, {"1": 1, "0": 0}, {"0": 0, "1": 1},
    nullPrototype, ownProto, {__proto__: {inherited: 1}, a: 1},
    new Date(0), {at: new Date(0)}, {toJSON: () => "x"}, {toJSON: () => undefined}, {a: {toJSON: () => undefined}}, [{toJSON: () => 1}],
    {a: {toJSON: () => undefined}, b: 1}, keyEcho, {a: keyEcho}, [keyEcho], functionWithToJson, {f: functionWithToJson}, [functionWithToJson],
    new Box(1), {box: new Box(1)}, new Map([["a", 1]]), new Set([1]), Object(Symbol("s")),
    Object("a"), Object(1), Object(true), Object(NaN), {n: Object(2)}, new Uint8Array([1, 2]), () => 1, Symbol("s"),
    nested(300, 1), nested(300, 2), nested(300, keyEcho), nested(301, keyEcho), nested(300, {f: functionWithToJson}),
    {value: 1}, {box: {value: 1}}, [new Box(1), {value: 1}], [{value: 1}, new Box(1)],
    {toJSON: overriddenCall}, {toJSON: () => new Date(0)}, {toJSON: () => ({toJSON: () => 1})}, {toJSON: () => new Box(2)},
    {toJSON: () => [new Date(0)]}, {toJSON: () => Object(5)}, {toJSON: () => Symbol("s")}, {toJSON: () => () => 1},
    proxied, {"1": "a", "2": "b"}, {"2": "b", "1": "a"}, new Proxy([1, 2], {}), nested(300, proxied), nested(300, {"1": "a", "2": "b"}),
    {toJSON: () => ({toJSON: () => undefined, a: 1})}, {a: 1}, {toJSON: () => ({toJSON: () => 2})}, {toJSON: 1}, {toJSON: () => 1},
    Object.setPrototypeOf(Object(false), Object.prototype), Object.setPrototypeOf(Object(true), Object.prototype), {},
    Object.setPrototypeOf(Object("s"), Object.prototype), Object.setPrototypeOf(Object(7), Object.prototype), null, {d: new Date(0)}, {d: "1970-01-01T00:00:00.000Z"},
    ...(rawJson === undefined ? [] : [rawJson("9007199254740992"), rawJson("9007199254740993"), 9007199254740992, rawJson("1e2"), 100, rawJson('"\\u0061"'), "a", rawJson("123"), {rawJSON: "123"}, 123, {a: rawJson("1")}, {a: 1}, {a: rawJson("\"x\"")}, {a: "x"}]),
];

describe("jsonSnapshot", () => {
    it("serializes to the text of JSON.stringify for every edge case", () => {
        for (const value of VALUES) {
            expect(text(jsonSnapshot(value)), String(JSON.stringify(value))).toBe(JSON.stringify(value));
        }
    });

    it("reads the value like JSON.stringify: each getter and toJSON once, in the same order, with the same keys", () => {
        const trace = (log: string[]) => {
            const item = {
                get a() {
                    log.push("get a");
                    return {toJSON: (key: string) => (log.push(`toJSON ${key}`), [1, 2])};
                },
                get b() {
                    log.push("get b");
                    return new Date(0);
                },
            };
            return {list: [item, {toJSON: (key: string) => (log.push(`toJSON ${key}`), undefined)}]};
        };
        const stringified: string[] = [];
        const snapshotted: string[] = [];
        const expected = JSON.stringify(trace(stringified));

        expect(text(jsonSnapshot(trace(snapshotted)))).toBe(expected);
        expect(snapshotted).toEqual(stringified);
        expect(snapshotted).toEqual(["get a", "toJSON a", "get b", "toJSON 1"]);
    });

    it("keeps the length and keys that it read first, like JSON.stringify, when the value changes during the walk", () => {
        const make = () => {
            const list: unknown[] = [];
            Object.defineProperty(list, 0, {enumerable: true, get: () => (list.push("late"), "first")});
            const record: Record<string, unknown> = {};
            Object.defineProperty(record, "a", {enumerable: true, get: () => (delete record["b"], record["c"] = 3, 1)});
            record["b"] = 2;
            return {list, record};
        };

        expect(text(jsonSnapshot(make()))).toBe(JSON.stringify(make()));
    });

    it("throws a TypeError where JSON.stringify throws", () => {
        const cyclic: Record<string, unknown> = {a: 1};
        cyclic["self"] = cyclic;
        const deepCycle = nested(400, cyclic);

        const coercedToBigInt = Object.assign(Object(1) as object, {[Symbol.toPrimitive]: () => 1n});
        const bigLength = new Proxy([], {get: (target, name) => name === "length" ? 1n : Reflect.get(target, name)});
        const unboxable = Object.setPrototypeOf(Object(7), null) as object;
        for (const value of [cyclic, deepCycle, {a: 1n}, [2n], Object(3n), {toJSON: () => 1n}, coercedToBigInt, bigLength, {a: unboxable}]) {
            expect(() => JSON.stringify(value)).toThrow(TypeError);
            expect(() => jsonSnapshot(value)).toThrow(TypeError);
        }
        const repeated = {x: 1};
        expect(text(jsonSnapshot({a: repeated, b: [repeated, repeated]}))).toBe("{\"a\":{\"x\":1},\"b\":[{\"x\":1},{\"x\":1}]}");
    });

    it("serializes like JSON.stringify when Object.prototype has toJSON", () => {
        const prototype = Object.prototype as {toJSON?: unknown};
        prototype.toJSON = function (this: unknown, key: string) {
            return Array.isArray(this) ? this : `polluted:${key}`;
        };
        try {
            for (const value of [{a: 1}, [1, {b: 2}], new Date(0), {d: new Date(0)}, nested(300, {a: 1}), [new Box(1)]]) {
                expect(text(jsonSnapshot(value))).toBe(JSON.stringify(value));
            }
        } finally {
            delete prototype.toJSON;
        }
    });

    it("leaves values nested thousands deep to JSON.stringify", () => {
        const deep = nested(4000, 1);
        const snapshot = jsonSnapshot(deep);

        expect(text(snapshot)).toBe(JSON.stringify(deep));
        expect(sameJson(jsonSnapshot(nested(4000, 1), snapshot), snapshot)).toBe(true);
        expect(sameJson(jsonSnapshot(nested(4000, 2), snapshot), snapshot)).toBe(false);
    });

    it("reuses the text of a value that JSON.stringify serialized", () => {
        const previous = jsonSnapshot([new Box(1), {at: new Date(0)}]);

        expect(jsonSnapshot([new Box(1), {at: new Date(0)}], previous)).toBe(previous);
        expect(text(jsonSnapshot([new Box(2), {at: new Date(0)}], previous))).toBe("[{\"value\":2},{\"at\":\"1970-01-01T00:00:00.000Z\"}]");
    });

    it("returns undefined where JSON.stringify returns undefined", () => {
        for (const value of [undefined, () => 1, Symbol("s"), {toJSON: () => undefined}]) {
            expect(JSON.stringify(value)).toBeUndefined();
            expect(jsonSnapshot(value)).toBeUndefined();
        }
    });
});

describe("sameJson", () => {
    it("agrees with a comparison of the serialized texts for every pair of edge cases", () => {
        for (const recorded of VALUES) {
            for (const value of VALUES) {
                expect(sameJson(jsonSnapshot(value), jsonSnapshot(recorded)), `${String(JSON.stringify(value))} vs ${String(JSON.stringify(recorded))}`)
                    .toBe(sameText(value, recorded));
            }
        }
    });

    it("tells apart content that changes but keeps its length", () => {
        const text = "x".repeat(100_000);
        const changed = `${text.slice(0, 50_000)}y${text.slice(50_001)}`;
        const content = (body: string) => [{type: "diff", path: "/a.ts", oldText: body, newText: body}];

        expect(changed.length).toBe(text.length);
        expect(sameJson(jsonSnapshot(content(changed)), jsonSnapshot(content(text)))).toBe(false);
        expect(sameJson(jsonSnapshot(content(text)), jsonSnapshot(content(Buffer.from(text).toString("utf8"))))).toBe(true);
        expect(sameJson(jsonSnapshot([{type: "text", text: "ab"}]), jsonSnapshot([{type: "text", text: "ba"}]))).toBe(false);
        expect(sameJson(jsonSnapshot({a: 12, b: 3}), jsonSnapshot({a: 1, b: 23}))).toBe(false);
        expect(sameJson(jsonSnapshot({ab: 1}), jsonSnapshot({ba: 1}))).toBe(false);
    });

    it("reuses the unchanged parts of the previous snapshot, and agrees with the texts for every pair of edge cases", () => {
        for (const recorded of VALUES) {
            const snapshot = jsonSnapshot(recorded);
            for (const value of VALUES) {
                const reusing = jsonSnapshot(value, snapshot);
                expect(text(reusing)).toBe(JSON.stringify(value));
                expect(sameJson(reusing, snapshot)).toBe(sameText(value, recorded));
            }
        }
        const previous = jsonSnapshot({list: [{a: "x"}, {b: "y"}], other: {c: 1}}) as JsonObject;
        const next = jsonSnapshot({list: [{a: "x"}, {b: "z"}], other: {c: 1}}, previous) as JsonObject;
        const list = (tree: JsonObject) => tree.values[0] as readonly JsonTree[];

        expect(next).not.toBe(previous);
        expect(list(next)[0]).toBe(list(previous)[0]);
        expect(next.values[1]).toBe(previous.values[1]);
        expect(jsonSnapshot({list: [{a: "x"}, {b: "y"}], other: {c: 1}}, previous)).toBe(previous);
    });

    it("keeps the recorded value when the reported object changes in place", () => {
        const content = [{type: "content", content: {type: "text", text: "a"}}];
        const snapshot = jsonSnapshot(content);
        content[0]!.content.text = "b";

        expect(sameJson(jsonSnapshot(content), snapshot)).toBe(false);
        expect(sameJson(jsonSnapshot([{type: "content", content: {type: "text", text: "a"}}]), snapshot)).toBe(true);
    });

    it("agrees with a comparison of the serialized texts for random mutations of random values", () => {
        let seed = 42;
        const random = () => {
            seed = (seed * 1103515245 + 12345) % 2147483648;
            return seed / 2147483648;
        };
        const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
        const leaves: unknown[] = [null, true, false, 0, -0, 1, 2, NaN, "", "a", "b", "ab", "ba", undefined, () => 1, keyEcho];
        const generate = (depth: number): unknown => {
            const roll = random();
            if (depth > 3 || roll < 0.4) return pick(leaves);
            if (roll < 0.7) return Array.from({length: Math.floor(random() * 4)}, () => generate(depth + 1));
            const object: Record<string, unknown> = {};
            for (let index = Math.floor(random() * 4); index > 0; index--) object[pick(["a", "b", "c", "1"])] = generate(depth + 1);
            return object;
        };
        const clone = (value: unknown): unknown => {
            if (Array.isArray(value)) return value.map(clone);
            if (value !== null && typeof value === "object" && value !== keyEcho) {
                return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]));
            }
            return value;
        };
        const mutate = (value: unknown, depth: number): unknown => {
            if (random() < 0.3 || depth > 3) return generate(depth);
            if (Array.isArray(value)) {
                const copy = [...value];
                if (copy.length > 0 && random() < 0.6) copy[Math.floor(random() * copy.length)] = mutate(copy[0], depth + 1);
                else if (random() < 0.5) copy.reverse();
                else copy.push(pick(leaves));
                return copy;
            }
            if (value !== null && typeof value === "object" && value !== keyEcho) {
                const entries = Object.entries(value);
                if (entries.length > 0 && random() < 0.6) {
                    const [key, item] = pick(entries);
                    return {...value, [key]: mutate(item, depth + 1)};
                }
                return Object.fromEntries(random() < 0.5 ? entries.reverse() : [...entries, [pick(["a", "d"]), pick(leaves)]]);
            }
            return random() < 0.5 ? pick(leaves) : value;
        };

        let same = 0;
        for (let run = 0; run < 20_000; run++) {
            const recorded = generate(0);
            const value = random() < 0.2 ? clone(recorded) : mutate(recorded, 0);
            const expected = sameText(value, recorded);
            if (expected) same++;
            const snapshot = jsonSnapshot(recorded);
            expect(sameJson(jsonSnapshot(value), snapshot)).toBe(expected);
            const reusing = jsonSnapshot(value, snapshot);
            expect(sameJson(reusing, snapshot)).toBe(expected);
            expect(text(reusing)).toBe(JSON.stringify(value));
            expect(text(snapshot)).toBe(JSON.stringify(recorded));
            if (expected && snapshot !== null && typeof snapshot === "object") expect(reusing).toBe(snapshot);
        }
        // Both outcomes are covered.
        expect(same).toBeGreaterThan(1000);
        expect(same).toBeLessThan(19_000);
    });
});

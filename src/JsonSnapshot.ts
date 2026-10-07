import {types} from "node:util";

/**
 * A value as `JSON.stringify` serializes it, kept as a tree instead of text.
 *
 * `ToolCallReports` compares each field of a tool call report with the field it reported before.
 * A field can hold megabytes, for example the diffs of a large patch,
 * and serializing it for each report stalls the event loop.
 * The tree copies only the plain objects and arrays of the value and shares its strings,
 * and two trees are equal exactly when the serialized texts are equal, see `sameJson`.
 * A string comparison does not escape the string, so it is much cheaper than serializing it.
 *
 * The walk handles only primitives, plain objects, plain arrays and `toJSON`.
 * Any other value, for example a `Date`, a class instance, a proxy, a function or a value nested too deep,
 * is serialized by `JSON.stringify` itself into a `JsonText`. So each part of the value is read once,
 * either by the walk or by `JSON.stringify`, and in the order of `JSON.stringify`.
 */
export type JsonTree = null | boolean | number | string | readonly JsonTree[] | JsonObject | JsonText;

/** The serialized members of a plain object, in the order of the text. */
export class JsonObject {
    constructor(readonly keys: readonly string[], readonly values: readonly JsonTree[]) {}
}

/** The serialized text of a value that `JSON.stringify` serialized. */
export class JsonText {
    constructor(readonly text: string) {}
}

/** Deeper values go to `JSON.stringify`, so that the walk does not use more stack than the serializer. */
const MAX_DEPTH = 256;
const apply = Reflect.apply;
const getPrototypeOf = Object.getPrototypeOf;
/** `JSON.rawJSON` values serialize as their raw text. */
const isRawJson = (JSON as {isRawJSON?: (value: unknown) => boolean}).isRawJSON ?? (() => false);

/**
 * Returns the tree of `JSON.stringify(value)`, or `undefined` when it returns `undefined`.
 * A value that `JSON.stringify` rejects throws its error.
 *
 * The tree reuses each part of `previous` that serializes to the same text,
 * so an unchanged value returns `previous` itself, and allocates only the containers that changed.
 */
export function jsonSnapshot(value: unknown, previous?: JsonTree): JsonTree | undefined {
    return serializeProperty(value, "", previous, [], 0);
}

/** Returns whether the serialized texts of two trees from `jsonSnapshot` are equal. */
export function sameJson(left: JsonTree | undefined, right: JsonTree | undefined): boolean {
    // `0 === -0`, and both serialize as `0`. A non-finite number is already `null`.
    // A tree from `jsonSnapshot` with `previous` is `previous` itself when the texts are equal.
    if (left === right) return true;
    if (left === undefined || right === undefined) return false;
    if (left instanceof JsonText || right instanceof JsonText) return jsonText(left) === jsonText(right);
    if (left instanceof JsonObject) {
        return right instanceof JsonObject && sameList(left.keys, right.keys) && sameTrees(left.values, right.values);
    }
    return Array.isArray(left) && Array.isArray(right) && sameTrees(left, right);
}

/** Returns the text that `JSON.stringify` gives for the value of the tree. */
export function jsonText(tree: JsonTree): string {
    if (tree instanceof JsonText) return tree.text;
    if (tree instanceof JsonObject) {
        const members = tree.keys.map((key, index) => `${JSON.stringify(key)}:${jsonText(tree.values[index]!)}`);
        return `{${members.join(",")}}`;
    }
    if (Array.isArray(tree)) return `[${tree.map(jsonText).join(",")}]`;
    return JSON.stringify(tree);
}

function sameList(left: readonly string[], right: readonly string[]): boolean {
    if (left.length !== right.length) return false;
    for (let index = 0; index < left.length; index++) {
        if (left[index] !== right[index]) return false;
    }
    return true;
}

function sameTrees(left: readonly JsonTree[], right: readonly JsonTree[]): boolean {
    if (left.length !== right.length) return false;
    for (let index = 0; index < left.length; index++) {
        if (!sameJson(left[index]!, right[index]!)) return false;
    }
    return true;
}

/** `SerializeJSONProperty` of ECMA-262 after the `Get`, without a replacer. */
function serializeProperty(
    value: unknown,
    key: string | number,
    previous: JsonTree | undefined,
    ancestors: object[],
    depth: number,
): JsonTree | undefined {
    switch (typeof value) {
        case "string":
        case "boolean":
            return value;
        case "number":
            return Number.isFinite(value) ? value : null;
        case "undefined":
        case "symbol":
            return undefined;
        case "object":
            if (value === null) return null;
            if (depth >= MAX_DEPTH || !isPlain(value)) return reused(serializeNatively(value, String(key), false), previous);
            break;
        default:
            // Functions, which can have `toJSON`, and bigints, which `JSON.stringify` rejects unless they have one.
            return reused(serializeNatively(value, String(key), false), previous);
    }
    const toJSON: unknown = (value as {toJSON?: unknown}).toJSON;
    if (typeof toJSON !== "function") return serializeContainer(value, previous, ancestors, depth);
    const result: unknown = apply(toJSON, value, [String(key)]);
    switch (typeof result) {
        case "string":
        case "boolean":
            return result;
        case "number":
            return Number.isFinite(result) ? result : null;
        case "undefined":
        case "symbol":
        case "function":
            return undefined;
        case "object":
            if (result === null) return null;
            // `JSON.stringify` does not call the `toJSON` of the result.
            return isPlain(result) && depth < MAX_DEPTH
                ? serializeContainer(result, previous, ancestors, depth)
                : reused(serializeNatively(result, String(key), true), previous);
        default:
            return reused(serializeNatively(result, String(key), true), previous);
    }
}

/** Whether the walk reads the object like `JSON.stringify`: a plain object or array that is not a proxy. */
function isPlain(value: object): boolean {
    if (types.isProxy(value) || types.isBoxedPrimitive(value) || isRawJson(value)) return false;
    const prototype: unknown = getPrototypeOf(value);
    return Array.isArray(value) ? prototype === Array.prototype : prototype === Object.prototype || prototype === null;
}

function serializeContainer(value: object, previous: JsonTree | undefined, ancestors: object[], depth: number): JsonTree {
    // The ancestors are few, so a list is cheaper than a set.
    if (ancestors.includes(value)) throw new TypeError("Converting circular structure to JSON");
    ancestors.push(value);
    const tree = Array.isArray(value)
        ? serializeArray(value, Array.isArray(previous) ? previous : undefined, ancestors, depth)
        : serializeMembers(value as Record<string, unknown>, previous instanceof JsonObject ? previous : undefined, ancestors, depth);
    ancestors.pop();
    return tree;
}

function serializeArray(
    value: readonly unknown[],
    previous: readonly JsonTree[] | undefined,
    ancestors: object[],
    depth: number,
): readonly JsonTree[] {
    const length = value.length;
    // While every item equals the item of `previous`, the array is not copied.
    let tree: JsonTree[] | undefined = previous?.length === length ? undefined : new Array<JsonTree>(length);
    for (let index = 0; index < length; index++) {
        const before = previous?.[index];
        // The index becomes a string only for a `toJSON` call.
        const item = serializeProperty(value[index], index, before, ancestors, depth + 1) ?? null;
        if (tree === undefined) {
            if (item === before) continue;
            tree = previous!.slice(0, index);
            tree.length = length;
        }
        tree[index] = item;
    }
    return tree ?? previous!;
}

function serializeMembers(
    value: Record<string, unknown>,
    previous: JsonObject | undefined,
    ancestors: object[],
    depth: number,
): JsonObject {
    const keys = Object.keys(value);
    // While every member equals the member of `previous`, the values are not copied.
    let values: JsonTree[] | undefined = previous === undefined ? new Array<JsonTree>(keys.length) : undefined;
    let count = 0;
    for (let index = 0; index < keys.length; index++) {
        const key = keys[index]!;
        const before = previous?.keys[count] === key ? previous.values[count] : undefined;
        const item = serializeProperty(value[key], key, before, ancestors, depth + 1);
        if (item === undefined) continue;
        // `keys` is a fresh array, so it can keep only the serialized keys.
        if (count !== index) keys[count] = key;
        if (values === undefined) {
            if (item === before && previous!.keys[count] === key) {
                count++;
                continue;
            }
            values = previous!.values.slice(0, count);
        }
        values[count++] = item;
    }
    keys.length = count;
    if (values === undefined) {
        if (count === previous!.keys.length) return previous!;
        values = previous!.values.slice(0, count);
    }
    values.length = count;
    // The record keeps the keys of `previous` when they did not change.
    return new JsonObject(previous !== undefined && sameList(keys, previous.keys) ? previous.keys : keys, values);
}

/** Returns `previous` for the same text, so that an unchanged value keeps the record of its container. */
function reused(tree: JsonText | undefined, previous: JsonTree | undefined): JsonText | undefined {
    return previous instanceof JsonText && tree?.text === previous.text ? previous : tree;
}

/**
 * Serializes the property `key` with `JSON.stringify`, which reads the value once and calls its `toJSON` with the key.
 * After a `toJSON` call, `converted` keeps `JSON.stringify` from calling the `toJSON` of the result.
 */
function serializeNatively(value: unknown, key: string, converted: boolean): JsonText | undefined {
    // Without a prototype, the holder has no `toJSON`, even when `Object.prototype` has one.
    const holder = {__proto__: null, [key]: converted ? null : value};
    const text = converted || key === "toJSON" ? serializeWithReplacer(holder, key, value, converted) : JSON.stringify(holder);
    const prefix = `{${JSON.stringify(key)}:`;
    // The text of a primitive stays text too, because `JSON.rawJSON` can give a number more digits than a number has.
    return text.startsWith(prefix) ? new JsonText(text.slice(prefix.length, -1)) : undefined;
}

/**
 * Serializes the holder as the result of the replacer for the root, so that `JSON.stringify` does not call a `toJSON`
 * of the holder, and replaces the placeholder of a converted value with the value.
 * The replacer costs a call for each property, so the common case serializes the holder without it.
 */
function serializeWithReplacer(holder: object, key: string, value: unknown, converted: boolean): string {
    let root = true;
    return JSON.stringify(null, function (this: unknown, name: string, item: unknown) {
        if (root) {
            root = false;
            return holder;
        }
        return converted && this === holder && name === key ? value : item;
    }) as string;
}

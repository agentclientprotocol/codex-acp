import {randomUUID} from "node:crypto";
import {mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {expect, it} from "vitest";
import {SessionOutputs} from "../SessionOutputs";

it("lists and reads live session-owned bytes and removes only the deleted session's directory", async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), "acp-outputs-"));
    const sessionId = randomUUID();
    const other = randomUUID();
    const outputs = new SessionOutputs(root);
    const relative = "results/壁纸.zip";
    const file = join(root, sessionId, relative);
    try {
        await expect(outputs.list(sessionId)).resolves.toEqual({outputs: []});
        await mkdir(join(root, sessionId, "results"), {recursive: true});
        await mkdir(join(root, other));
        await writeFile(join(root, other, "shared.pdf"), "other session");
        await symlink(join(root, other), join(root, sessionId, "escape"), "dir");
        const contents = Buffer.from([0x50, 0x4b, 0xff, 0x00, 0x80, 0xfe]);
        await writeFile(file, contents);
        const {outputs: [item]} = await outputs.list(sessionId);
        expect(item).toMatchObject({name: "壁纸.zip", size: contents.length});
        const id = item!.id;
        const first = await outputs.read({sessionId, outputId: id, offset: 0, length: 3});
        const second = await outputs.read({sessionId, outputId: id, offset: 3, length: 3, revision: first.revision});
        expect(Buffer.concat([Buffer.from(first.dataBase64, "base64"), Buffer.from(second.dataBase64, "base64")])).toEqual(contents);
        await expect(outputs.read({sessionId, outputId: "acp_" + Buffer.from("escape/shared.pdf").toString("base64url"), offset: 0, length: 3}))
            .rejects.toMatchObject({code: -32002});
        await expect(outputs.read({sessionId: other, outputId: id, offset: 0, length: 3})).rejects.toMatchObject({code: -32002});
        await writeFile(file, "updated");
        await expect(outputs.read({sessionId, outputId: id, offset: 3, length: 3, revision: first.revision}))
            .rejects.toMatchObject({code: -32010});
        await expect(new SessionOutputs(root).list(sessionId)).resolves.toMatchObject({outputs: [{id, size: 7}]});

        await outputs.remove(sessionId);
        await outputs.remove(sessionId);
        await expect(outputs.list(sessionId)).resolves.toEqual({outputs: []});
        await expect(readFile(join(root, other, "shared.pdf"), "utf8")).resolves.toBe("other session");
    } finally {
        await rm(root, {recursive: true, force: true});
    }
});

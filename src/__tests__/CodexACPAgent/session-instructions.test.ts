import {describe, expect, it, vi} from "vitest";
import {createCodexMockTestFixture, createTestModel} from "../acp-test-utils";
import {CodexAcpClient} from "../../CodexAcpClient";

function fixture(config: Record<string, any> = {}) {
    const f = createCodexMockTestFixture();
    const app = f.getCodexAppServerClient();
    const client = new CodexAcpClient(app, config);
    const thread = {id: "office-thread", historyMode: "paginated", turns: []};
    const response = {thread, model: "gpt-5", modelProvider: "openai", reasoningEffort: null,
        serviceTier: null, itemsBackwardsCursor: null};
    vi.spyOn(app, "listSkills").mockResolvedValue({data: []});
    vi.spyOn(app, "listModels").mockResolvedValue({data: [createTestModel({id:"gpt-5"})], nextCursor: null});
    vi.spyOn(app, "configRead").mockResolvedValue({config: {developer_instructions:"user/project rules"}} as any);
    vi.spyOn(app, "threadLoadedList").mockResolvedValue({data: [], nextCursor: null});
    vi.spyOn(app, "threadStart").mockResolvedValue(response as any);
    vi.spyOn(app, "threadResume").mockResolvedValue(response as any);
    vi.spyOn(app, "threadFork").mockResolvedValue(response as any);
    vi.spyOn(app, "threadUnsubscribe").mockResolvedValue({} as any);
    return {client, app};
}

const request = {cwd:"/workspace", mcpServers:[], sessionId:"office-thread"};
const metadata = {_meta: {systemPrompt: {append:"role-specific rules"}}};

describe("session instruction append", () => {
    for (const method of ["newSession", "resumeSession", "loadSession", "forkSession"] as const) {
        it(`${method} preserves effective user rules and does not replace base instructions`, async () => {
            const {client, app} = fixture();
            await client[method]({...request, ...metadata});
            const spy = method === "newSession" ? app.threadStart : method === "forkSession" ? app.threadFork : app.threadResume;
            expect(spy).toHaveBeenCalledOnce();
            const sent = vi.mocked(spy).mock.calls[0]![0];
            expect(sent.developerInstructions).toBe("user/project rules\n\nrole-specific rules");
            expect(sent).not.toHaveProperty("baseInstructions");
            expect(app.configRead).toHaveBeenCalledWith({cwd:"/workspace", includeLayers:false});
        });
        it(`${method} leaves the existing path untouched without append metadata`, async () => {
            const {client, app} = fixture();
            await client[method](request);
            const spy = method === "newSession" ? app.threadStart : method === "forkSession" ? app.threadFork : app.threadResume;
            expect(vi.mocked(spy).mock.calls[0]![0]).not.toHaveProperty("developerInstructions");
            expect(app.threadLoadedList).not.toHaveBeenCalled();
        });
        it(`${method} rejects invalid metadata before any thread or skill side effect`, async () => {
            const {client, app} = fixture();
            await expect(client[method]({...request, _meta:{systemPrompt:{append:42}}})).rejects.toThrow();
            expect(app.listSkills).not.toHaveBeenCalled();
            expect(app.threadStart).not.toHaveBeenCalled();
            expect(app.threadResume).not.toHaveBeenCalled();
            expect(app.threadFork).not.toHaveBeenCalled();
        });
    }
    it("preserves CODEX_CONFIG precedence without mutating shared config or leaking to another session", async () => {
        const config = {developer_instructions:"launch rules"};
        const {client, app} = fixture(config);
        await client.newSession({...request, ...metadata});
        await client.newSession(request);
        expect(vi.mocked(app.threadStart).mock.calls[0]![0].developerInstructions).toBe("launch rules\n\nrole-specific rules");
        expect(vi.mocked(app.threadStart).mock.calls[1]![0]).not.toHaveProperty("developerInstructions");
        expect(config).toEqual({developer_instructions:"launch rules"});
    });
    for (const method of ["resumeSession", "loadSession"] as const) {
        it(`${method} refuses instruction changes on a loaded thread instead of silently ignoring them`, async () => {
            const {client, app} = fixture();
            vi.mocked(app.threadLoadedList).mockResolvedValueOnce({data:["other"],nextCursor:"next-page"})
                .mockResolvedValueOnce({data:[request.sessionId],nextCursor:null});
            await expect(client[method]({...request,...metadata})).rejects.toThrow(/loaded/);
            expect(app.threadLoadedList).toHaveBeenLastCalledWith({cursor:"next-page"});
            expect(app.threadResume).not.toHaveBeenCalled();
        });
    }
});

it("rejects simultaneous append and AIR replacement before side effects",async()=>{
 const {client,app}=fixture();
 await expect(client.newSession({...request,_meta:{systemPrompt:{append:"role"},jetbrains:{air:{customInstructions:"replacement"}}}})).rejects.toThrow(/cannot be combined/);
 expect(app.configRead).not.toHaveBeenCalled();expect(app.listSkills).not.toHaveBeenCalled();expect(app.threadStart).not.toHaveBeenCalled();
});
it("preserves upstream AIR-only custom instructions",async()=>{
 const {client,app}=fixture();
 await client.newSession({...request,_meta:{jetbrains:{air:{customInstructions:"AIR rules"}}}});
 expect(vi.mocked(app.threadStart).mock.calls[0]![0].developerInstructions).toBe("AIR rules");
});

it("explicit empty append restores configured rules rather than retaining an earlier role",async()=>{
 const {client,app}=fixture();await client.loadSession({...request,_meta:{systemPrompt:{append:""}}});
 expect(vi.mocked(app.threadResume).mock.calls[0]![0].developerInstructions).toBe("user/project rules");
});

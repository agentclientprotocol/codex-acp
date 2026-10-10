import {it, expect} from "vitest";
import {mkdtemp, mkdir, writeFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {createServer} from "node:http";
import {once} from "node:events";
import {startCodexConnection, type CodexConnection} from "../../CodexJsonRpcConnection";
import {CodexAppServerClient} from "../../CodexAppServerClient";
import {CodexAcpClient} from "../../CodexAcpClient";

// Real Codex, isolated home, local fixture provider: inspect the actual model
// request rather than treating a successful thread/start as proof of injection.
it("native Codex retains appended roles across turns, compaction, fork and process restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-session-instructions-"));
    const home = join(root, "home"), cwd = join(root, "project");
    await mkdir(home); await mkdir(cwd);
    const requests: any[] = [];
    const server = createServer(async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
        requests.push({url:req.url,body});
        if (req.url?.endsWith("/responses/compact")) {
            res.writeHead(200, {"content-type":"application/json"});
            res.end(JSON.stringify({id:"compact",object:"response.compaction",created_at:1,
                output:[{type:"compaction",encrypted_content:"fixture-compacted-history"}],
                usage:{input_tokens:10,output_tokens:5,total_tokens:15}}));
            return;
        }
        const id = `response-${requests.length}`;
        const item = {type:"message",id,role:"assistant",status:"completed",
            content:[{type:"output_text",text:"native-role-turn-complete",annotations:[]}]};
        const response = {id,object:"response",created_at:1,status:"completed",output:[item],
            usage:{input_tokens:20,output_tokens:5,total_tokens:25,input_tokens_details:{cached_tokens:0},output_tokens_details:{reasoning_tokens:0}}};
        const event = (type:string,value:any) => `event: ${type}\ndata: ${JSON.stringify({type,...value})}\n\n`;
        res.writeHead(200, {"content-type":"text/event-stream"});
        res.end(event("response.created",{response:{...response,status:"in_progress",output:[]}})
            +event("response.output_item.added",{output_index:0,item})
            +event("response.output_item.done",{output_index:0,item})+event("response.completed",{response}));
    });
    server.listen(0,"127.0.0.1"); await once(server,"listening");
    const port = (server.address() as {port:number}).port;
    await writeFile(join(home,"config.toml"), `model = "gpt-5.2"\nmodel_provider = "fixture"\ndeveloper_instructions = "native-user-rules"\n[model_providers.fixture]\nname = "Fixture"\nbase_url = "http://127.0.0.1:${port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n`);
    let native: CodexConnection | undefined;
    const open = async () => {
        native = startCodexConnection(resolve("node_modules/.bin/codex"), {...process.env, HOME:home, CODEX_HOME:home});
        const app = new CodexAppServerClient(native.connection), client = new CodexAcpClient(app);
        await client.initialize({protocolVersion:1});
        return {app,client};
    };
    const close = async () => {
        if (!native) return;
        const exited = once(native.process,"exit");
        native.process.kill(); await exited; native = undefined;
    };
    const metadata = {_meta:{systemPrompt:{append:"native-office-role"}}};
    try {
        let {app,client} = await open();
        const session = await client.newSession({cwd,mcpServers:[],...metadata});
        const turn = async (text:string, threadId = session.sessionId) => {
            const before = requests.length;
            const result = await app.runTurn({threadId,input:[{type:"text",text,text_elements:[]}]});
            expect(result.turn.status).toBe("completed");
            const sent = requests.slice(before).find(x=>x.url?.endsWith("/responses"));
            expect(sent).toBeDefined();
            const developer = JSON.stringify(sent.body.input.filter((x:any)=>x.role==="developer"));
            expect(developer).toContain("native-user-rules");
            expect(developer.split("native-office-role")).toHaveLength(2);
            expect(JSON.stringify(sent.body.input.filter((x:any)=>x.role==="user"))).not.toContain("native-office-role");
            expect(sent.body.instructions).toBeTruthy();
        };
        await turn("first native turn"); await turn("second native turn");
        await expect(client.loadSession({sessionId:session.sessionId,cwd,mcpServers:[],...metadata})).rejects.toThrow(/loaded/);
        const beforeCompact = requests.length;
        const compacted = await app.runCompact({threadId:session.sessionId});
        expect(requests.length).toBeGreaterThan(beforeCompact);
        expect(JSON.stringify(compacted)).toMatch(/completed|compacted/);
        if (compacted.method !== "turn/completed") {
            const completed = await app.awaitTurnCompleted(session.sessionId, compacted.params.turnId);
            expect(completed.turn.status).toBe("completed");
        }
        await turn("after native compaction");
        const fork = await client.forkSession({sessionId:session.sessionId,cwd,mcpServers:[],...metadata});
        await close();
        ({app,client} = await open());
        await client.resumeSession({sessionId:fork.sessionId,cwd,mcpServers:[],...metadata});
        await turn("forked native turn",fork.sessionId);
        await close();
        ({app,client} = await open());
        await client.loadSession({sessionId:session.sessionId,cwd,mcpServers:[],...metadata});
        await turn("after native restart");
        await close();
        ({app,client} = await open());
        await client.loadSession({sessionId:session.sessionId,cwd,mcpServers:[],_meta:{systemPrompt:{append:""}}});
        const resetBefore=requests.length;
        expect((await app.runTurn({threadId:session.sessionId,input:[{type:"text",text:"after clearing role",text_elements:[]}]})).turn.status).toBe("completed");
        const reset=requests.slice(resetBefore).find(x=>x.url?.endsWith("/responses"));
        expect(JSON.stringify(reset.body.input.filter((x:any)=>x.role==="developer"))).toContain("native-user-rules");
        // Codex may retain old instruction messages in history; its new override
        // must explicitly restore only the configured developer rules.
        expect(JSON.stringify(reset.body.input.filter((x:any)=>x.role==="user"))).not.toContain("native-office-role");
        const plain = await client.newSession({cwd,mcpServers:[]});
        const before = requests.length;
        expect((await app.runTurn({threadId:plain.sessionId,input:[{type:"text",text:"ordinary session",text_elements:[]}]})).turn.status).toBe("completed");
        expect(JSON.stringify(requests.slice(before))).not.toContain("native-office-role");
    } finally {
        await close(); server.close(); server.closeAllConnections();
        await rm(root,{recursive:true,force:true});
    }
}, 60000);

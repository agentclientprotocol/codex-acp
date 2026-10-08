import {createHash} from "node:crypto";
import {describe, expect, it, vi} from "vitest";
import {createCodexMockTestFixture, createTestSessionState, mockPromptTurn} from "../acp-test-utils";
import {SESSION_REWIND_METHOD} from "../../SessionRewind";
import {SESSION_STEERING_METHOD} from "../../AcpExtensions";
import {OPENAI_PROVIDER_ID} from "../../CodexAcpClient";
import type {CodexAcpServer, SessionState} from "../../CodexAcpServer";

const sessionId = "session-id";
const request = {sessionId, beforeMessage:{messageId:"user",messageFingerprint:`sha256:${createHash("sha256").update("original").digest("hex")}`,messageOccurrence:1}};
const steer = {sessionId,prompt:[{type:"text",text:"followup"}],_meta:{steering:{idleBehavior:"promptRequired"}}};
function deferred<T>() {let resolve!: (value:T)=>void; const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};}
function setup() {
    const fixture=createCodexMockTestFixture();
    const agent=fixture.getCodexAcpAgent();
    const state=createTestSessionState();
    (agent as unknown as {sessions:Map<string,SessionState>}).sessions.set(sessionId,state);
    return {fixture,agent,state,client:fixture.getCodexAcpClient(),native:fixture.getCodexAppServerClient()};
}
function rewind(agent:CodexAcpServer) {return agent.extMethod(SESSION_REWIND_METHOD,request);}

describe("rewind lifecycle",()=>{
    it("rejects competing operations while rewinding and releases the fence on validation failure",async()=>{
        const {agent,client}=setup(); const gate=deferred<{rewound:boolean}>();
        const call=vi.spyOn(client,"rewindSession").mockReturnValue(gate.promise);
        const pending=rewind(agent);
        await vi.waitFor(()=>expect(call).toHaveBeenCalledOnce());
        for(const attempt of [
            ()=>rewind(agent),()=>agent.closeSession({sessionId}),
            ()=>agent.resumeSession({sessionId,cwd:"/test/cwd",mcpServers:[]}),
            ()=>agent.loadSession({sessionId,cwd:"/test/cwd",mcpServers:[]}),
            ()=>agent.prompt({sessionId,prompt:[]}),
            ()=>agent.extMethod(SESSION_STEERING_METHOD,steer),
            ()=>agent.setSessionMode({sessionId,modeId:"read-only"}),
            ()=>agent.setSessionConfigOption({sessionId,configId:"model",value:"m"}),
            ()=>agent.readSessionRuntime({sessionId,resource:"context"}),
        ]) await expect(attempt()).rejects.toThrow();
        gate.resolve({rewound:true});await pending;
        call.mockRejectedValueOnce(new Error("invalid target"));
        await expect(rewind(agent)).rejects.toThrow("invalid target");
        call.mockResolvedValue({rewound:true});
        await expect(rewind(agent)).resolves.toEqual({rewound:true});
    });
    it("does not let rewind overtake an earlier settings change",async()=>{
        const {agent,client}=setup();const gate=deferred<void>();
        const settings=vi.spyOn(client,"setCollaborationMode").mockReturnValue(gate.promise);
        const pending=agent.setSessionConfigOption({sessionId,configId:"collaboration_mode",value:"plan"});
        await vi.waitFor(()=>expect(settings).toHaveBeenCalledOnce());
        const call=vi.spyOn(client,"rewindSession");
        await expect(rewind(agent)).rejects.toMatchObject({data:expect.stringContaining("update is in progress")});
        expect(call).not.toHaveBeenCalled();gate.resolve();await pending;
    });
    it("blocks a later provider replacement until rewind has finished",async()=>{
        const replacement=createCodexMockTestFixture().getCodexAcpClient();
        vi.spyOn(replacement,"initialize").mockResolvedValue();
        vi.spyOn(replacement,"resumeSession").mockResolvedValue({} as never);
        const restart=vi.fn().mockResolvedValue(replacement);
        const fixture=createCodexMockTestFixture(restart);const agent=fixture.getCodexAcpAgent();
        await agent.initialize({protocolVersion:1});
        (agent as unknown as {sessions:Map<string,SessionState>}).sessions.set(sessionId,createTestSessionState());
        const gate=deferred<{rewound:boolean}>();
        const call=vi.spyOn(fixture.getCodexAcpClient(),"rewindSession").mockReturnValue(gate.promise);
        const pending=rewind(agent);await vi.waitFor(()=>expect(call).toHaveBeenCalledOnce());
        const update=agent.setProvider({providerId:OPENAI_PROVIDER_ID,apiType:"openai",baseUrl:"https://example.test/v1"});
        await Promise.resolve();expect(restart).not.toHaveBeenCalled();
        gate.resolve({rewound:true});await pending;await update;expect(restart).toHaveBeenCalledOnce();
    });
    it("requires a successful load after a dispatched rewind has an unknown outcome",async()=>{
        const {agent,client,fixture}=setup();
        const call=vi.spyOn(client,"rewindSession").mockImplementation(async(_request,hooks)=>{hooks?.mutationStarted?.();throw Error("reload failed");});
        await expect(rewind(agent)).rejects.toThrow("reload failed");
        await expect(agent.prompt({sessionId,prompt:[]})).rejects.toMatchObject({data:expect.stringContaining("outcome is uncertain")});
        await expect(agent.extMethod(SESSION_STEERING_METHOD,steer)).rejects.toMatchObject({data:expect.stringContaining("outcome is uncertain")});
        await expect(rewind(agent)).rejects.toMatchObject({data:expect.stringContaining("outcome is uncertain")});
        vi.spyOn(agent as unknown as {loadSessionDuringOperation:()=>Promise<{}>},"loadSessionDuringOperation").mockRejectedValueOnce(Error("read failed")).mockResolvedValue({});
        await expect(agent.loadSession({sessionId,cwd:"/test/cwd",mcpServers:[]})).rejects.toThrow("read failed");
        await expect(rewind(agent)).rejects.toMatchObject({data:expect.stringContaining("outcome is uncertain")});
        await agent.loadSession({sessionId,cwd:"/test/cwd",mcpServers:[]});
        call.mockResolvedValue({rewound:true});await rewind(agent);
        mockPromptTurn(fixture,sessionId);
        await expect(agent.prompt({sessionId,prompt:[{type:"text",text:"continue"}]})).resolves.toMatchObject({stopReason:"end_turn"});
    });
    it("rejects rewind in the turn-start registration gap without releasing an unknown writer",async()=>{
        const {agent,fixture,native,client}=setup();const started=deferred<never>();
        const turnStart=vi.spyOn(native,"turnStart").mockReturnValue(started.promise);
        const pending=agent.prompt({sessionId,prompt:[{type:"text",text:"starting"}]});
        await vi.waitFor(()=>expect(turnStart).toHaveBeenCalledOnce());
        const call=vi.spyOn(client,"rewindSession");
        await expect(rewind(agent)).rejects.toMatchObject({data:expect.stringContaining("startup is pending")});expect(call).not.toHaveBeenCalled();
        await agent.closeSession({sessionId});await expect(pending).resolves.toMatchObject({stopReason:"cancelled"});
        started.resolve({turn:{id:"late",items:[],itemsView:"notLoaded",status:"interrupted",error:null,startedAt:null,completedAt:null,durationMs:null}} as never);
        await vi.waitFor(()=>expect(fixture.getCodexConnectionEvents([]).some(e=>e.eventType==="request"&&e.method==="turn/interrupt")).toBe(true));
    });
});

describe("opt-in steering",()=>{
    it("returns promptRequired while idle without calling turn/start",async()=>{
        const {agent,native}=setup();const start=vi.spyOn(native,"turnStart");
        await expect(agent.extMethod(SESSION_STEERING_METHOD,steer)).resolves.toEqual({outcome:"promptRequired"});
        expect(start).not.toHaveBeenCalled();
    });
    it("returns promptRequired if the native turn ends before steer is accepted",async()=>{
        const {agent,native,state}=setup();state.currentTurnId="active";
        const gate=deferred<never>();const call=vi.spyOn(native,"turnSteer").mockReturnValue(gate.promise);
        const pending=agent.extMethod(SESSION_STEERING_METHOD,steer);
        await vi.waitFor(()=>expect(call).toHaveBeenCalledOnce());
        state.currentTurnId=null;gate.resolve(Promise.reject(Error("no active turn to steer")) as never);
        await expect(pending).resolves.toEqual({outcome:"promptRequired"});
    });
    it("blocks rewind while a steer is already in flight",async()=>{
        const {agent,native,client,state}=setup();state.currentTurnId="active";
        const gate=deferred<never>();const call=vi.spyOn(native,"turnSteer").mockReturnValue(gate.promise);
        const pending=agent.extMethod(SESSION_STEERING_METHOD,steer);
        await vi.waitFor(()=>expect(call).toHaveBeenCalledOnce());
        const revert=vi.spyOn(client,"rewindSession");await expect(rewind(agent)).rejects.toMatchObject({data:expect.stringContaining("update is in progress")});
        expect(revert).not.toHaveBeenCalled();gate.resolve({} as never);await expect(pending).resolves.toEqual({outcome:"injected"});
    });
});

describe("runtime lifecycle",()=>{
    it("requires provider idle for MCP reconnect, and fences all sessions while reconnecting",async()=>{
        const {agent,client}=setup();const gate=deferred<void>();const reload=vi.spyOn(client,"reloadMcpServers").mockReturnValue(gate.promise);
        const pending=agent.controlSessionRuntime({sessionId,action:"reconnectMcp"});await vi.waitFor(()=>expect(reload).toHaveBeenCalledOnce());
        await expect(agent.prompt({sessionId,prompt:[]})).rejects.toMatchObject({data:expect.stringContaining("Runtime control")});
        await expect(rewind(agent)).rejects.toMatchObject({data:expect.stringContaining("Runtime control")});
        await expect(agent.closeSession({sessionId})).rejects.toMatchObject({data:expect.stringContaining("Runtime control")});
        await expect(agent.setProvider({providerId:OPENAI_PROVIDER_ID,apiType:"openai",baseUrl:"https://example.test"})).rejects.toMatchObject({data:expect.stringContaining("Runtime control")});
        gate.resolve();await expect(pending).resolves.toMatchObject({status:"ok",data:{scope:"provider",connectionsReady:false}});
    });
    it("rejects reconnect while a prompt is active",async()=>{
        const {agent,fixture,client,native}=setup();mockPromptTurn(fixture,sessionId);const finish=deferred<never>();
        vi.spyOn(native,"awaitTurnCompleted").mockReturnValue(finish.promise);
        const pending=agent.prompt({sessionId,prompt:[{type:"text",text:"running"}]});
        await vi.waitFor(()=>expect(agent.getSessionState(sessionId).currentTurnId).toBe("turn-id"));
        const reload=vi.spyOn(client,"reloadMcpServers");await expect(agent.controlSessionRuntime({sessionId,action:"reconnectMcp"})).rejects.toMatchObject({data:expect.stringContaining("Provider is busy")});expect(reload).not.toHaveBeenCalled();
        await agent.closeSession({sessionId});await pending;
    });
    it("republishes available commands after reloadSkills and releases the control fence",async()=>{
        const {agent,client}=setup();const skills=vi.spyOn(client,"listSkills").mockResolvedValue({data:[]});
        const publish=vi.spyOn(agent as unknown as {publishAvailableCommands:()=>Promise<void>},"publishAvailableCommands").mockResolvedValue();
        await agent.controlSessionRuntime({sessionId,action:"reloadSkills"});expect(skills).toHaveBeenCalledWith({cwds:["/test/cwd"],forceReload:true});expect(publish).toHaveBeenCalledOnce();
        await expect(agent.extMethod(SESSION_STEERING_METHOD,steer)).resolves.toEqual({outcome:"promptRequired"});
    });
});


describe("native pending queue admission", () => {
    it.each(["load", "resume"] as const)("does not reopen after close during %s queue preflight", async method => {
        const {agent,client,native} = setup();
        client.queueSupport = {nativeVersion:"0.160.1",actions:["list"]};
        const pending = deferred<{data:[],nextCursor:null}>();
        const list = vi.fn().mockReturnValue(pending.promise);
        vi.spyOn(native,"queueNative").mockReturnValue({list} as never);
        const resume = vi.spyOn(client,"resumeSession");
        const load = vi.spyOn(client,"loadSession");
        const opening = method === "load" ? agent.loadSession({sessionId,cwd:"/test/cwd",mcpServers:[]}) : agent.resumeSession({sessionId,cwd:"/test/cwd",mcpServers:[]});
        const rejection = expect(opening).rejects.toMatchObject({data:expect.stringContaining("changed while checking")});
        await vi.waitFor(()=>expect(list).toHaveBeenCalledOnce());
        await agent.closeSession({sessionId});
        pending.resolve({data:[],nextCursor:null});
        await rejection;
        expect(resume).not.toHaveBeenCalled();expect(load).not.toHaveBeenCalled();
    });
    it("does not read or resume a session while close already holds its fence", async () => {
        const {agent,client,native} = setup();
        client.queueSupport={nativeVersion:"0.160.1",actions:["list"]};
        const release=deferred<void>();vi.spyOn(client,"closeSession").mockReturnValue(release.promise);
        const closing=agent.closeSession({sessionId});
        const list=vi.fn();vi.spyOn(native,"queueNative").mockReturnValue({list} as never);
        await expect(agent.resumeSession({sessionId,cwd:"/test/cwd",mcpServers:[]})).rejects.toMatchObject({data:expect.stringContaining("closing")});
        expect(list).not.toHaveBeenCalled();release.resolve();await closing;
    });
    it("rejects persisted pending work before native resume can auto-dispatch", async () => {
        const {agent,client,native}=setup();client.queueSupport={nativeVersion:"0.160.1",actions:["list"]};
        vi.spyOn(native,"queueNative").mockReturnValue({list:vi.fn().mockResolvedValue({data:[{id:"queued"}],nextCursor:null})} as never);
        const resume=vi.spyOn(client,"resumeSession");
        await expect(agent.resumeSession({sessionId,cwd:"/test/cwd",mcpServers:[]})).rejects.toMatchObject({data:expect.stringContaining("pending queue")});
        expect(resume).not.toHaveBeenCalled();
    });
});


describe("provider control recovery", () => {
    it("invalidates sessions after a hung control, keeps close reachable and rejects late installation", async () => {
        vi.useFakeTimers();
        try {
            const {agent,client}=setup();
            const native = deferred<void>();
            vi.spyOn(client,"reloadMcpServers").mockReturnValue(native.promise);
            const pending=agent.controlSessionRuntime({sessionId,action:"reconnectMcp"});
            const failure=expect(pending).rejects.toThrow("timed out");
            await vi.advanceTimersByTimeAsync(30_000);
            await failure;
            await expect(agent.closeSession({sessionId})).resolves.toEqual({});
            await expect(agent.newSession({cwd:"/test/cwd",mcpServers:[]})).rejects.toMatchObject({data:expect.stringContaining("invalidated")});
            await expect(agent.setProvider({providerId:OPENAI_PROVIDER_ID,apiType:"openai",baseUrl:"https://example.test"})).rejects.toMatchObject({data:expect.stringContaining("invalidated")});
            native.resolve();await Promise.resolve();
            expect(()=>agent.getSessionState(sessionId)).toThrow();
        } finally { vi.useRealTimers(); }
    });
    it("reserves creation before an asynchronous new session can install", async () => {
        const {agent,client,state}=setup();
        const created=deferred<never>();
        const open=vi.spyOn(agent as unknown as {getOrCreateSession:()=>Promise<never>},"getOrCreateSession").mockReturnValue(created.promise);
        const pending=agent.newSession({cwd:"/test/cwd",mcpServers:[]});
        await vi.waitFor(()=>expect(open).toHaveBeenCalledOnce());
        const reload=vi.spyOn(client,"reloadMcpServers");
        await expect(agent.controlSessionRuntime({sessionId,action:"reconnectMcp"})).rejects.toMatchObject({data:expect.stringContaining("Provider is busy")});
        await expect(agent.revertFiles({sessionId,toolCallId:"file",dryRun:true})).rejects.toMatchObject({data:expect.stringContaining("Provider is busy")});
        await expect(agent.setProvider({providerId:OPENAI_PROVIDER_ID,apiType:"openai",baseUrl:"https://example.test"})).rejects.toThrow();
        expect(reload).not.toHaveBeenCalled();
        created.resolve([sessionId,{currentModelId:state.currentModelId,availableModels:[]},{currentModeId:"agent",availableModes:[]}] as never);
        await pending;
        reload.mockResolvedValue();
        await expect(agent.controlSessionRuntime({sessionId,action:"reconnectMcp"})).resolves.toMatchObject({status:"ok"});
    });
});

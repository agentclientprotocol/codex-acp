import {createHash} from "node:crypto";
import {describe, expect, it, vi} from "vitest";
import {createCodexMockTestFixture, createTestSessionState, mockPromptTurn} from "../acp-test-utils";
import {SESSION_REWIND_METHOD} from "../../SessionRewind";
import {SESSION_STEERING_METHOD} from "../../AcpExtensions";
import {OPENAI_PROVIDER_ID} from "../../CodexAcpClient";
import type {CodexAcpServer, SessionState} from "../../CodexAcpServer";

const sessionId = "session-id";
const request = {sessionId, beforeMessage:{messageId:"user",messageFingerprint:`sha256:${createHash("sha256").update("original").digest("hex")}`,messageOccurrence:1}};
const steer = {sessionId,prompt:[{type:"text",text:"followup"}]};
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

describe("steering lifecycle",()=>{
    it("blocks rewind while a steer is already in flight",async()=>{
        const {agent,native,client,state}=setup();state.currentTurnId="active";
        const gate=deferred<never>();const call=vi.spyOn(native,"turnSteer").mockReturnValue(gate.promise);
        const pending=agent.extMethod(SESSION_STEERING_METHOD,steer);
        await vi.waitFor(()=>expect(call).toHaveBeenCalledOnce());
        const revert=vi.spyOn(client,"rewindSession");await expect(rewind(agent)).rejects.toMatchObject({data:expect.stringContaining("update is in progress")});
        expect(revert).not.toHaveBeenCalled();gate.resolve({} as never);await expect(pending).resolves.toEqual({outcome:"injected"});
    });
});

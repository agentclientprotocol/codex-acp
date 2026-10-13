import {createHash} from 'node:crypto';
import {describe, it, expect, vi} from 'vitest';
import {createRecoveryFixture, defaultAnswer, initialize, requestsOf} from './recovery-fixture';
import {SESSION_REWIND_METHOD} from '../../SessionRewind';
async function setup() {
 const f=createRecoveryFixture(); await initialize(f,true,{_meta:{jetbrains:{air:{version:1,capabilities:['sessionIndex']}}}});
 const {sessionId}=await f.agent.newSession({cwd:'/work',mcpServers:[]});
 const metadata=defaultAnswer('thread/resume',{threadId:sessionId}) as any;
 let turns:any[]=[{id:'old-turn',items:[{type:'userMessage',id:'old-user',content:[{type:'text',text:'discard this'}]}],status:'completed',error:null}];
 const read=()=>({thread:{...metadata.thread,historyMode:'legacy',turns}});
 f.answers.set('thread/read',read);
 f.answers.set('thread/resume',()=>({...metadata,thread:read().thread,materialized:true}));
 f.answers.set('thread/rollback',()=>{turns=[];return read();});
 const request={sessionId,beforeMessage:{messageId:'old-user',messageFingerprint:`sha256:${createHash('sha256').update('discard this').digest('hex')}`,messageOccurrence:1}};
 return {...f,sessionId,rewind:()=>f.agent.extMethod(SESSION_REWIND_METHOD,request)};
}
const titleResult={turn:{items:[{type:'agentMessage',id:'title-item',text:'{"title":"Title from replaced state"}'}],status:'completed',error:null}};
const flush=()=>new Promise<void>(resolve=>setImmediate(resolve));
describe('title work inherited from a replaced SessionState',()=>{
 for(const method of ['loadSession','resumeSession'] as const) it(`rejects obsolete title output after ${method} replaces its generator and rewind succeeds`,async()=>{
  const f=await setup(); const old=f.agent.getSessionState(f.sessionId).titleGen!;
  const native=(f.agent as any).codexAcpClient.appServerClient;
  let release!:(v:any)=>void;
  const model=vi.spyOn(native,'runTurn').mockImplementation(()=>new Promise(r=>{release=r;}));
  old.onTurnCompleted('discard this');
  await vi.waitFor(()=>expect(model).toHaveBeenCalledOnce());
  const loadWait=vi.spyOn(old,'waitForIdle');
  if(method==='loadSession') {
   vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
   try {
    const opened=f.agent.loadSession({sessionId:f.sessionId,cwd:'/work',mcpServers:[]});
    await vi.advanceTimersByTimeAsync(0);
    expect(loadWait).toHaveBeenCalledWith(10_000);
    await vi.advanceTimersByTimeAsync(10_000);
    await opened;
   } finally { vi.useRealTimers(); }
  } else {
   await f.agent.resumeSession({sessionId:f.sessionId,cwd:'/work',mcpServers:[]});
   expect(loadWait).not.toHaveBeenCalled();
  }
  expect(f.agent.getSessionState(f.sessionId).titleGen).not.toBe(old);
  await expect(f.rewind()).resolves.toEqual({rewound:true});
  release(titleResult); await flush();
  const writes=requestsOf(f.current(),'thread/name/set');
  old.observeRename(); await old.waitForIdle(50);
  expect(writes).toEqual([]);
 });
 it('retains the drain fence for a title write dispatched by a generator replaced by resume',async()=>{
  const f=await setup(); const old=f.agent.getSessionState(f.sessionId).titleGen!;
  const native=(f.agent as any).codexAcpClient.appServerClient;
  vi.spyOn(native,'runTurn').mockResolvedValue(titleResult);
  f.answers.set('thread/name/set',()=>undefined);
  old.onTurnCompleted('discard this');
  await vi.waitFor(()=>expect(f.current().rpc.hasPending('thread/name/set')).toBe(true));
  await f.agent.resumeSession({sessionId:f.sessionId,cwd:'/work',mcpServers:[]});
  const rewind=f.rewind(); rewind.catch(()=>{});
  await flush();
  const mutationsBeforeAck=requestsOf(f.current(),'thread/rollback');
  f.current().rpc.resolve('thread/name/set',{});
  await rewind; await flush(); old.observeRename(); await old.waitForIdle(50);
  expect(mutationsBeforeAck).toEqual([]);
 });

 it('retains unacknowledged title work across close and reopen',async()=>{
  const f=await setup(); const old=f.agent.getSessionState(f.sessionId).titleGen!;
  const native=(f.agent as any).codexAcpClient.appServerClient;
  const model=vi.spyOn(native,'runTurn').mockResolvedValue(titleResult);
  f.answers.set('thread/name/set',()=>undefined);
  old.onTurnCompleted('discard this');
  await vi.waitFor(()=>expect(f.current().rpc.hasPending('thread/name/set')).toBe(true));
  await f.agent.closeSession({sessionId:f.sessionId});
  await f.agent.resumeSession({sessionId:f.sessionId,cwd:'/work',mcpServers:[]});
  const rewind=f.rewind(); rewind.catch(()=>{}); await flush();
  expect(requestsOf(f.current(),'thread/rollback')).toEqual([]);
  f.current().rpc.resolve('thread/name/set',{});
  await expect(rewind).resolves.toEqual({rewound:true});
  old.onTurnCompleted('must not restart a retired generator');
  expect(model).toHaveBeenCalledOnce();
 });

 it('keeps rejected writes from retired generators fenced on later attempts',async()=>{
  const f=await setup(); const old=f.agent.getSessionState(f.sessionId).titleGen!;
  const native=(f.agent as any).codexAcpClient.appServerClient;
  vi.spyOn(native,'runTurn').mockResolvedValue(titleResult);
  f.answers.set('thread/name/set',()=>new Error('lost title acknowledgement'));
  old.onTurnCompleted('discard this');
  await vi.waitFor(()=>expect(requestsOf(f.current(),'thread/name/set')).toHaveLength(1));
  await old.waitForIdle(50);
  await f.agent.resumeSession({sessionId:f.sessionId,cwd:'/work',mcpServers:[]});
  for(let attempt=0;attempt<2;attempt++) {
   await expect(f.rewind()).rejects.toThrow('Automatic title write was not acknowledged');
  }
  expect(requestsOf(f.current(),'thread/rollback')).toEqual([]);
 });
});

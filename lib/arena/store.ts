import {env} from 'cloudflare:workers';
import {redactMessage,type ChatMessage,type TranscriptEntry} from './conversation.ts';
import {advance,ArenaError,type Game,type Agent,publicState} from './engine.ts';
function db(){if(!env.DB)throw new ArenaError('Arena database is unavailable.',503);return env.DB;}
export async function insertGame(g:Game){await db().prepare('INSERT INTO arena_games (id,state,version,created_at,status,ends_at) VALUES (?,?,0,?,?,?)').bind(g.id,JSON.stringify(g),g.createdAt,g.status,g.endsAt).run();}
export function authenticate(g:Game,token:string|null|undefined,hostOnly=false):Agent|null {
 if(token&&token===g.hostToken)return null;
 if(!hostOnly&&token){const a=g.agents.find(a=>a.id!=='$atlas'&&a.token===token);if(a)return a;}
 throw new ArenaError(hostOnly?'A valid host token is required.':'A valid host or agent token is required.',401);
}
export function agentAuth(g:Game,token:string|null|undefined){const a=g.agents.find(a=>a.id!=='$atlas'&&!!token&&a.token===token);if(!a)throw new ArenaError('A valid agent token is required.',401);return a;}
export type Journal=(agentId:string,decisionId:string,step:number,messages:ChatMessage[],secrets?:string[])=>void;
// One decision-metrics row: server-measured for website rounds, self-reported for external agents.
export type DecisionRecord={agentId:string;decisionId:string;round:number;source:'server'|'self_reported';provider?:string|null;model?:string|null;reasoningEffort?:string|null;temperature?:number|null;maxTokens?:number|null;observationTime?:number|null;responseTime?:number|null;executionTime?:number|null;observationRevision?:number|null;executionRevision?:number|null;llmMs?:number|null;executionMs?:number|null;stalenessMs?:number|null;casRetries?:number|null;promptTokens?:number|null;completionTokens?:number|null;observedBestBid?:number|null;observedBestAsk?:number|null;executedBestBid?:number|null;executedBestAsk?:number|null;bookMoved?:boolean|null;late?:boolean|null;actions?:unknown;note?:string|null;reasoning?:string|null};
export type Transaction={attempt:number;revision:number;record:(row:DecisionRecord)=>void};
const DECISION_COLUMNS='game_id,agent_id,decision_id,round,source,provider,model,reasoning_effort,temperature,max_tokens,observation_time,response_time,execution_time,observation_revision,execution_revision,llm_ms,execution_ms,staleness_ms,cas_retries,prompt_tokens,completion_tokens,observed_best_bid,observed_best_ask,executed_best_bid,executed_best_ask,book_moved,late,actions,note,reasoning,created_at';
function decisionInsert(gameId:string,d:DecisionRecord,version:number,now:number){
 const n=(v:unknown)=>typeof v==='number'&&Number.isFinite(v)?v:null,b=(v:unknown)=>v==null?null:v?1:0,s=(v:unknown)=>typeof v==='string'?v.slice(0,200):null;
 // The version guard only matches when this transaction's game update won the compare-and-swap.
 return db().prepare(`INSERT INTO arena_decisions (${DECISION_COLUMNS}) SELECT ${DECISION_COLUMNS.split(',').map(()=>'?').join(',')} FROM arena_games WHERE id=? AND version=? ON CONFLICT(game_id,agent_id,decision_id,round) DO NOTHING`).bind(gameId,d.agentId,d.decisionId,d.round,d.source,s(d.provider),s(d.model),s(d.reasoningEffort),n(d.temperature),n(d.maxTokens),n(d.observationTime),n(d.responseTime),n(d.executionTime),n(d.observationRevision),n(d.executionRevision),n(d.llmMs),n(d.executionMs),n(d.stalenessMs),n(d.casRetries),n(d.promptTokens),n(d.completionTokens),n(d.observedBestBid),n(d.observedBestAsk),n(d.executedBestBid),n(d.executedBestAsk),b(d.bookMoved),b(d.late),d.actions==null?null:JSON.stringify(d.actions).slice(0,20000),typeof d.note==='string'&&d.note.trim()?d.note.trim().slice(0,600):null,typeof d.reasoning==='string'&&d.reasoning.trim()?d.reasoning.trim().slice(0,100000):null,now,gameId,version);
}
export async function change<T>(id:string,fn:(g:Game,now:number,journal:Journal,tx:Transaction)=>T|Promise<T>,clock:()=>number=Date.now):Promise<{result:T;state:ReturnType<typeof publicState>;revision:number;attempts:number}> {
 if(typeof id!=='string'||!/^game_[a-f0-9-]{36}$/.test(id))throw new ArenaError('Invalid game ID.');
 for(let i=0;i<20;i++){
  const row=await db().prepare('SELECT state,version FROM arena_games WHERE id=?').bind(id).first<{state:string;version:number}>();
  if(!row)throw new ArenaError('Game not found.',404);
  const g=JSON.parse(row.state) as Game,now=clock();advance(g,now);
  const pending:{agentId:string;decisionId:string;step:number;message:string}[]=[],decisions:DecisionRecord[]=[];
  const journal:Journal=(agentId,decisionId,step,messages,secrets=[])=>{const a=g.agents.find(a=>a.id===agentId)!;if(!a)throw new ArenaError('Unknown history owner.');for(const [offset,message] of messages.entries())pending.push({agentId,decisionId,step:step+offset,message:JSON.stringify(redactMessage(message,[...secrets,g.hostToken,...g.agents.map(a=>a.token)]))});a.historyMessages=(a.historyMessages??0)+messages.length;};
  const tx:Transaction={attempt:i,revision:row.version+1,record:entry=>{decisions.push(entry);}};
  // Even a rejected late order must persist deadline finalization.
  let result!:T,error:unknown;try{result=await fn(g,now,journal,tx);}catch(e){error=e;}
  if(error){
   const original=JSON.parse(row.state) as Game;
   advance(original,now);
   if(JSON.stringify(original)===row.state)throw error;
   const write=await db().prepare('UPDATE arena_games SET state=?,version=version+1,status=?,ends_at=? WHERE id=? AND version=?').bind(JSON.stringify(original),original.status,original.endsAt,id,row.version).run();
   if(write.meta.changes===1)throw error;
  }else{
   const serialized=JSON.stringify(g);
   if(!pending.length&&!decisions.length&&serialized===row.state)return {result,state:publicState(g,now),revision:row.version,attempts:i+1};
   const update=db().prepare('UPDATE arena_games SET state=?,version=version+1,status=?,ends_at=? WHERE id=? AND version=?').bind(serialized,g.status,g.endsAt,id,row.version);
   const statements=[update];
   if(pending.length){
    // One transaction: losing the game CAS also suppresses every transcript row.
    const rows=pending.map(()=> 'SELECT ? AS agent_id, ? AS decision_id, ? AS step, ? AS message').join(' UNION ALL ');
    statements.push(db().prepare('INSERT INTO arena_messages (game_id,agent_id,decision_id,step,message,created_at) SELECT ?,entry.agent_id,entry.decision_id,entry.step,entry.message,? FROM ('+rows+') AS entry WHERE changes()=1 ON CONFLICT(game_id,agent_id,decision_id,step) DO NOTHING').bind(id,now,...pending.flatMap(p=>[p.agentId,p.decisionId,p.step,p.message])));
   }
   for(const entry of decisions)statements.push(decisionInsert(id,entry,row.version+1,now));
   const write:D1Result=statements.length>1?(await db().batch(statements))[0]:await update.run();
   if(write.meta.changes===1)return {result,state:publicState(g,now),revision:row.version+1,attempts:i+1};
  }
 }
 throw new ArenaError('Game is busy. Retry with the same request ID.',409);
}

// Atomic shared-key allowance, independent of game count and client tokens.
export async function reserveDefaultCall(now=Date.now()){
 const day=new Date(now).toISOString().slice(0,10),configured=Number(env.SAIL_DEFAULT_DAILY_CALL_LIMIT),limit=Number.isInteger(configured)&&configured>0&&configured<=100000?configured:3000;
 const row=await db().prepare('INSERT INTO arena_default_usage (day,calls) VALUES (?,1) ON CONFLICT(day) DO UPDATE SET calls=calls+1 WHERE calls<? RETURNING calls').bind(day,limit).first<{calls:number}>();
 if(!row)throw new ArenaError('The arena-provided agents have reached today’s shared allowance. Add an agent with your own provider key, or try tomorrow.',429);
}

// Settle every running game past its deadline without waiting for a client request. Idempotent: advance() finalizes once.
export async function finalizeDue(now=Date.now(),limit=10){
 const due=await db().prepare('SELECT id FROM arena_games WHERE status=? AND ends_at<=? ORDER BY ends_at LIMIT ?').bind('running',now,Math.max(1,Math.min(50,Math.floor(limit)))).all<{id:string}>();
 const finalized:string[]=[];
 for(const {id} of due.results){try{const r=await change(id,g=>g.status);if(r.state.status==='finished')finalized.push(id);}catch(error){console.error('Finalization sweep failed',{id,detail:error instanceof Error?error.message:'unknown'});}}
 return {checked:due.results.length,finalized};
}

export async function transcript(id:string,agentId:string):Promise<TranscriptEntry[]>{const r=await db().prepare('SELECT id,created_at AS time,decision_id AS decisionId,step,message FROM arena_messages WHERE game_id=? AND agent_id=? ORDER BY id').bind(id,agentId).all<{id:number;time:number;decisionId:string;step:number;message:string}>();return r.results.map(row=>({...row,message:JSON.parse(row.message)}));}
export async function gameTranscripts(id:string,allowedAgentIds:string[]){const result=[];for(const agentId of allowedAgentIds)result.push({agentId,messages:await transcript(id,agentId)});return result;}
export type DecisionEntry=Omit<DecisionRecord,'bookMoved'|'late'|'actions'>&{id:number;createdAt:number;bookMoved:boolean|null;late:boolean|null;actions:unknown};
export async function decisions(id:string,agentIds:string[]):Promise<DecisionEntry[]>{
 if(!agentIds.length)return [];
 const r=await db().prepare(`SELECT id,agent_id AS agentId,decision_id AS decisionId,round,source,provider,model,reasoning_effort AS reasoningEffort,temperature,max_tokens AS maxTokens,observation_time AS observationTime,response_time AS responseTime,execution_time AS executionTime,observation_revision AS observationRevision,execution_revision AS executionRevision,llm_ms AS llmMs,execution_ms AS executionMs,staleness_ms AS stalenessMs,cas_retries AS casRetries,prompt_tokens AS promptTokens,completion_tokens AS completionTokens,observed_best_bid AS observedBestBid,observed_best_ask AS observedBestAsk,executed_best_bid AS executedBestBid,executed_best_ask AS executedBestAsk,book_moved AS bookMoved,late,actions,note,reasoning,created_at AS createdAt FROM arena_decisions WHERE game_id=? AND agent_id IN (${agentIds.map(()=>'?').join(',')}) ORDER BY id`).bind(id,...agentIds).all<any>();
 return r.results.map(row=>({...row,bookMoved:row.bookMoved==null?null:!!row.bookMoved,late:row.late==null?null:!!row.late,actions:row.actions?JSON.parse(row.actions):null}));
}

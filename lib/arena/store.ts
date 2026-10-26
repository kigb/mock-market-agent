import {env} from 'cloudflare:workers';
import {redactMessage,type ChatMessage,type TranscriptEntry} from './conversation.ts';
import {advance,ArenaError,type Game,type Agent,publicState} from './engine.ts';
function db(){if(!env.DB)throw new ArenaError('Arena database is unavailable.',503);return env.DB;}
export async function insertGame(g:Game){await db().prepare('INSERT INTO arena_games (id,state,version,created_at) VALUES (?,?,0,?)').bind(g.id,JSON.stringify(g),g.createdAt).run();}
export function authenticate(g:Game,token:string|null|undefined,hostOnly=false):Agent|null {
 if(token&&token===g.hostToken)return null;
 if(!hostOnly&&token){const a=g.agents.find(a=>a.id!=='$atlas'&&a.token===token);if(a)return a;}
 throw new ArenaError(hostOnly?'A valid host token is required.':'A valid host or agent token is required.',401);
}
export function agentAuth(g:Game,token:string|null|undefined){const a=g.agents.find(a=>a.id!=='$atlas'&&!!token&&a.token===token);if(!a)throw new ArenaError('A valid agent token is required.',401);return a;}
export type Journal=(agentId:string,decisionId:string,step:number,messages:ChatMessage[],secrets?:string[])=>void;
export async function change<T>(id:string,fn:(g:Game,now:number,journal:Journal)=>T|Promise<T>,clock:()=>number=Date.now):Promise<{result:T;state:ReturnType<typeof publicState>;revision:number}> {
 if(typeof id!=='string'||!/^game_[a-f0-9-]{36}$/.test(id))throw new ArenaError('Invalid game ID.');
 for(let i=0;i<20;i++){
  const row=await db().prepare('SELECT state,version FROM arena_games WHERE id=?').bind(id).first<{state:string;version:number}>();
  if(!row)throw new ArenaError('Game not found.',404);
  const g=JSON.parse(row.state) as Game,now=clock();advance(g,now);
  const pending:{agentId:string;decisionId:string;step:number;message:string}[]=[];
  const journal:Journal=(agentId,decisionId,step,messages,secrets=[])=>{const a=g.agents.find(a=>a.id===agentId)!;if(!a)throw new ArenaError('Unknown history owner.');for(const [offset,message] of messages.entries())pending.push({agentId,decisionId,step:step+offset,message:JSON.stringify(redactMessage(message,[...secrets,g.hostToken,...g.agents.map(a=>a.token)]))});a.historyMessages=(a.historyMessages??0)+messages.length;};
  // Even a rejected late order must persist deadline finalization.
  let result!:T,error:unknown;try{result=await fn(g,now,journal);}catch(e){error=e;}
  if(error){
   const original=JSON.parse(row.state) as Game;
   advance(original,now);
   if(JSON.stringify(original)===row.state)throw error;
   const write=await db().prepare('UPDATE arena_games SET state=?,version=version+1 WHERE id=? AND version=?').bind(JSON.stringify(original),id,row.version).run();
   if(write.meta.changes===1)throw error;
  }else{
   const serialized=JSON.stringify(g);
   if(!pending.length&&serialized===row.state)return {result,state:publicState(g,now),revision:row.version};
   const update=db().prepare('UPDATE arena_games SET state=?,version=version+1 WHERE id=? AND version=?').bind(serialized,id,row.version);
   let write:D1Result;
   if(pending.length){
    // One transaction: losing the game CAS also suppresses every transcript row.
    const rows=pending.map(()=> 'SELECT ? AS agent_id, ? AS decision_id, ? AS step, ? AS message').join(' UNION ALL ');
    const insert=db().prepare('INSERT INTO arena_messages (game_id,agent_id,decision_id,step,message,created_at) SELECT ?,entry.agent_id,entry.decision_id,entry.step,entry.message,? FROM ('+rows+') AS entry WHERE changes()=1 ON CONFLICT(game_id,agent_id,decision_id,step) DO NOTHING').bind(id,now,...pending.flatMap(p=>[p.agentId,p.decisionId,p.step,p.message]));
    [write]=await db().batch([update,insert]);
   }else write=await update.run();
   if(write.meta.changes===1)return {result,state:publicState(g,now),revision:row.version+1};
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

export async function transcript(id:string,agentId:string):Promise<TranscriptEntry[]>{const r=await db().prepare('SELECT id,created_at AS time,decision_id AS decisionId,step,message FROM arena_messages WHERE game_id=? AND agent_id=? ORDER BY id').bind(id,agentId).all<{id:number;time:number;decisionId:string;step:number;message:string}>();return r.results.map(row=>({...row,message:JSON.parse(row.message)}));}
export async function gameTranscripts(id:string,allowedAgentIds:string[]){const result=[];for(const agentId of allowedAgentIds)result.push({agentId,messages:await transcript(id,agentId)});return result;}

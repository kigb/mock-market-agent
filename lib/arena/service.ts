import {env} from 'cloudflare:workers';
import {defaultAgent,DEFAULT_MAX_TOKENS,DEFAULT_MAX_MODEL_CALLS,DEFAULT_STRATEGY} from './presets.ts';
import {addAgent,addEvent,ArenaError,createGame,ensureRunning,intent,observation,publicState,RULES,rulesFor,startGame,type AgentSpec,type Game,type Intent} from './engine.ts';
import {agentAuth,authenticate,change,insertGame,reserveDefaultCall,transcript} from './store.ts';
import {converse,scriptedCompletion,type ChatMessage,type Completion} from './conversation.ts';
import {baseline,endpoint,complete,type ModelConfig} from './providers.ts';
export async function makeGame(specs:AgentSpec[]=[],seed=42,owner=''){const now=Date.now(),g=createGame('game_'+crypto.randomUUID(),crypto.randomUUID()+crypto.randomUUID(),owner,specs,now,seed);await insertGame(g);return {state:publicState(g,now),revision:0,hostToken:g.hostToken,agentTokens:g.agents.filter(a=>a.id!=='$atlas').map(a=>({id:a.id,name:a.name,token:a.token}))};}
export function runAction(g:Game,agentToken:string,input:any,now:number){
 const a=agentAuth(g,agentToken);
 if(input.action==='get_rules')return rulesFor(g);
 if(input.action==='get_order_book')return observation(g,a,now);
 if(input.action==='get_position'){const o=observation(g,a,now);return {position:o.position,openOrders:o.openOrders};}
 return intent(g,a,input as Intent,now,input.requestId);
}
export async function callTool(name:string,args:any,owner=''){
 if(name==='get_rules')return RULES;
 if(name==='create_game')return makeGame([],args.seed??42,owner);
 if(name==='register_agent')return change(args.gameId,(g,now)=>{authenticate(g,args.hostToken,true);const a=addAgent(g,{name:args.name,provider:'external',model:args.model},crypto.randomUUID(),crypto.randomUUID(),now);return {agentId:a.id,agentToken:a.token,name:a.name};});
 if(name==='start_game')return change(args.gameId,(g,now)=>{authenticate(g,args.hostToken,true);startGame(g,now);return {status:'running',endsAt:g.endsAt};});
 if(name==='record_decision')return change(args.gameId,(g,now)=>{const a=agentAuth(g,args.agentToken);ensureRunning(g,now);if(a.provider!=='external')throw new ArenaError('External telemetry is only accepted from external agents.');if(typeof args.requestId!=='string'||!args.requestId||args.requestId.length>100)throw new ArenaError('Supply a unique telemetry request ID.');const prior=g.receipts.find(r=>r.agentId===a.id&&r.id===args.requestId);if(prior)return prior.result;if(typeof args.latencyMs!=='number'||!Number.isFinite(args.latencyMs)||args.latencyMs<0||args.latencyMs>60000)throw new ArenaError('Invalid latency.');for(const n of [args.inputTokens??0,args.outputTokens??0])if(!Number.isInteger(n)||n<0||n>1000000)throw new ArenaError('Invalid token usage.');if(a.calls>=120)throw new ArenaError('External telemetry limit reached.',429);a.calls++;a.latencySamples=(a.latencySamples??0)+1;a.latencyMs+=args.latencyMs;a.promptTokens+=args.inputTokens??0;a.completionTokens+=args.outputTokens??0;const result={recorded:true};g.receipts.push({agentId:a.id,id:args.requestId,result});g.receipts=g.receipts.slice(-500);return result;});
 if(name==='get_results')return change(args.gameId,(g)=>{authenticate(g,args.token);return {status:g.status};});
 if(!['get_order_book','get_position','place_order','cancel_order','cancel_all','wait'].includes(name))throw new ArenaError('Unknown MCP tool.',404);
 return change(args.gameId,(g,now)=>runAction(g,args.agentToken,{...args,action:name},now));
}
export async function decision(id:string,token:string,config:ModelConfig|undefined){
 if(config)endpoint(config);
 const leaseId=crypto.randomUUID();let step=1;
 const claim=await change(id,(g,now,journal)=>{
  const a=agentAuth(g,token);ensureRunning(g,now);
  if(a.provider==='external')throw new ArenaError('External agents should use the MCP or REST order endpoints.');
  if(a.preset&&config)throw new ArenaError('Arena-provided agents use their fixed server configuration.');
  if(a.provider!=='baseline'&&!a.preset&&(!config||config.provider!==a.provider||config.model!==a.model))throw new ArenaError('Provider and model must match the registered agent.');
  if(a.preset&&a.calls>=DEFAULT_MAX_MODEL_CALLS)throw new ArenaError('This arena-provided agent reached its model-call limit.',429);
  if(a.calls>=120)throw new ArenaError('This agent reached the 120-call game limit.',429);
  if(a.leaseUntil>now||now-a.lastDecision<(a.intervalMs??2000))return {skipped:true} as const;
  a.leaseId=leaseId;a.leaseUntil=now+22000;a.lastDecision=now;
  const observed=observation(g,a,now);
  journal(a.id,leaseId,0,[{role:'user',content:JSON.stringify(observed)}],[config?.apiKey??'']);
  return {skipped:false,agentId:a.id,preset:a.preset,endsAt:g.endsAt!,actions:a.provider==='baseline'?baseline(g,a):null};
 });
 if(claim.result.skipped)return {...claim,result:{skipped:true}};
 const agentId=claim.result.agentId,deadline=Math.min(claim.result.endsAt,claim.state.now+14000);let totalActions=0,totalRounds=0,inferenceStarted=0;
 const beforeCall=async()=>{
  const checked=await change(id,(g,now)=>{const a=agentAuth(g,token);if(g.status!=='running'||a.leaseId!==leaseId||(a.preset&&a.calls>=DEFAULT_MAX_MODEL_CALLS)||a.calls>=120)return false;a.calls++;return true;});
  if(!checked.result)return false;
  if(claim.result.preset)await reserveDefaultCall();return true;
 };
 const commit=async(outcome:Completion,budget:number)=>{
  const startStep=step;const messageCount=1+outcome.calls.length;
  const applied=await change(id,(g,now,journal)=>{
   const a=agentAuth(g,token),late=g.status!=='running'||a.leaseId!==leaseId;
   const results=outcome.calls.map((call,i)=>{if(late)return {action:call.intent.action,ok:false,error:'Game deadline or decision lease passed; action was not executed.'};if(i>=budget)return {action:call.intent.action,ok:false,error:'The four-tool decision budget is exhausted; action was not executed.'};try{return {action:call.intent.action,ok:true,result:runAction(g,token,{...call.intent,requestId:leaseId+':'+startStep+':'+i},now)};}catch(e){a.errors++;const error=e instanceof ArenaError?e.message:'Trading action failed.';addEvent(g,now,a.id,'error',error);return {action:call.intent.action,ok:false,error};}});
   const replies:ChatMessage[]=results.map((result,i)=>({role:'tool',tool_call_id:outcome.calls[i].id,content:JSON.stringify(result)}));
   journal(a.id,leaseId,startStep,[outcome.message,...replies],[config?.apiKey??'']);
   if(!late){a.latencySamples=(a.latencySamples??0)+1;a.latencyMs+=outcome.latencyMs;a.promptTokens+=outcome.usage.promptTokens;a.completionTokens+=outcome.usage.completionTokens;addEvent(g,now,a.id,'decision',`${a.name} · ${outcome.calls.length} tool calls · ${outcome.latencyMs} ms · history retained`);}
   return {replies,late,results};
  });
  inferenceStarted=0;step+=messageCount;totalActions+=Math.min(outcome.calls.length,budget);totalRounds++;return applied.result;
 };
 try{
  if(claim.result.preset){const p=defaultAgent(claim.result.preset);if(!p||!env.SAIL_API_KEY)throw new ArenaError('The arena’s default Sail agents are unavailable. Add an agent with your own provider key.',503);config={provider:'sail',model:p.model,apiKey:env.SAIL_API_KEY,temperature:.3,maxTokens:DEFAULT_MAX_TOKENS,prompt:DEFAULT_STRATEGY,reasoningEffort:p.model.startsWith('zai-org/')?'low':p.model.startsWith('deepseek-ai/')?'none':undefined};}
  if(claim.result.actions){if(await beforeCall())await commit(scriptedCompletion(claim.result.actions),4);}
  else{
   const messages=(await transcript(id,agentId)).map(e=>e.message);
   await converse({messages,deadline,beforeCall,complete:(history,remaining)=>{inferenceStarted=Date.now();return complete(config!,history,remaining);},commit});
  }
  const released=await change(id,(g)=>{const a=agentAuth(g,token);if(a.leaseId===leaseId){a.leaseId='';a.leaseUntil=0;}return {modelRounds:totalRounds,toolCalls:totalActions,historyMessages:a.historyMessages??0};});return released;
 }catch(error){
  const message=error instanceof ArenaError&&/timed out/.test(error.message)&&Date.now()>=claim.result.endsAt?'Game ended before the model replied; no action was executed.':error instanceof ArenaError?error.message:'Provider request failed.';
  await change(id,(g,now,journal)=>{const a=agentAuth(g,token);journal(a.id,leaseId,step,[{role:'user',content:JSON.stringify({kind:'provider_error',serverTime:now,error:message})}],[config?.apiKey??'']);if(g.status==='running'&&a.leaseId===leaseId){if(inferenceStarted){a.latencySamples=(a.latencySamples??0)+1;a.latencyMs+=Date.now()-inferenceStarted;}a.leaseId='';a.leaseUntil=0;a.errors++;addEvent(g,now,a.id,'error',message);}return {};});
  throw error;
 }
}

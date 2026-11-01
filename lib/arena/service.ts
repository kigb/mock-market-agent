import {env} from 'cloudflare:workers';
import {defaultAgent,DEFAULT_MAX_TOKENS,DEFAULT_STRATEGY,presetCallLimit} from './presets.ts';
import {addAgent,addEvent,ArenaError,callLimit,createGame,DURATION,durationOf,ensureRunning,intent,MIN_DECISION_GAP_MS,observation,orderBook,publicState,RULES,rulesFor,startGame,type AgentSpec,type Game,type Intent} from './engine.ts';
import {agentAuth,authenticate,change,insertGame,replayMessages,reserveDefaultCall} from './store.ts';
import {converse,headerSnapshot,labelParty,labelTicks,leanOrders,leanPosition,leanSnapshot,leanToolResult,partyLabels,READ_TOOLS,readSummary,scriptedCompletion,type ChatMessage,type Completion} from './conversation.ts';
import {baseline,endpoint,complete,effectiveReasoningEffort,type ModelConfig} from './providers.ts';
export async function makeGame(specs:AgentSpec[]=[],seed=42,owner='',durationMs:number=DURATION){const now=Date.now(),g=createGame('game_'+crypto.randomUUID(),crypto.randomUUID()+crypto.randomUUID(),owner,specs,now,seed,undefined,durationMs);await insertGame(g);return {state:publicState(g,now),revision:0,hostToken:g.hostToken,agentTokens:g.agents.filter(a=>a.id!=='$atlas').map(a=>({id:a.id,name:a.name,token:a.token}))};}
export function runAction(g:Game,agentToken:string,input:any,now:number){
 const a=agentAuth(g,agentToken);
 if(input.action==='get_rules')return rulesFor(g);
 if(input.action==='get_order_book')return observation(g,a,now);
 const others=partyLabels(g.agents,a.id);
 if(input.action==='get_position'){const o=observation(g,a,now);return {position:leanPosition(o.position),openOrders:leanOrders(o.openOrders,o.serverTime)};}
 const limit=(fallback:number,max:number)=>Number.isInteger(input.limit)&&input.limit>=1?Math.min(input.limit,max):fallback;
 if(input.action==='get_atlas_history'){const o=observation(g,a,now);return {total:o.atlas.ticks.length,ticks:labelTicks(o.atlas.ticks.slice(-limit(20,300)),a.id,others)};}
 if(input.action==='get_fills'){return {fills:g.fills.slice(-limit(10,50)).reverse().map(f=>({time:f.time,side:f.side,price:f.price/100,quantity:f.quantity,taker:labelParty(f.taker,a.id,others),maker:labelParty(f.maker,a.id,others)}))};}
 return intent(g,a,input as Intent,now,input.requestId);
}
export async function callTool(name:string,args:any,owner=''){
 if(name==='get_rules')return RULES;
 if(name==='create_game')return makeGame([],args.seed??42,owner,args.durationSeconds===undefined?DURATION:Number(args.durationSeconds)*1000);
 if(name==='register_agent')return change(args.gameId,(g,now)=>{authenticate(g,args.hostToken,true);const a=addAgent(g,{name:args.name,provider:'external',model:args.model},crypto.randomUUID(),crypto.randomUUID(),now);return {agentId:a.id,agentToken:a.token,name:a.name};});
 if(name==='start_game')return change(args.gameId,(g,now)=>{authenticate(g,args.hostToken,true);startGame(g,now);return {status:'running',endsAt:g.endsAt};});
 if(name==='record_decision')return change(args.gameId,(g,now,_journal,tx)=>{
  const a=agentAuth(g,args.agentToken);ensureRunning(g,now);if(a.provider!=='external')throw new ArenaError('External telemetry is only accepted from external agents.');
  if(typeof args.requestId!=='string'||!args.requestId||args.requestId.length>100)throw new ArenaError('Supply a unique telemetry request ID.');
  const prior=g.receipts.find(r=>r.agentId===a.id&&r.id===args.requestId);if(prior)return prior.result;
  if(typeof args.latencyMs!=='number'||!Number.isFinite(args.latencyMs)||args.latencyMs<0||args.latencyMs>60000)throw new ArenaError('Invalid latency.');
  for(const n of [args.inputTokens??0,args.outputTokens??0])if(!Number.isInteger(n)||n<0||n>1000000)throw new ArenaError('Invalid token usage.');
  // Self-reported timestamps are epoch ms. observationTime/executionTime should be server stamps (serverTime, state.now) so staleness is clock-consistent.
  const stamp=(value:unknown,label:string)=>{if(value===undefined||value===null)return null;if(typeof value!=='number'||!Number.isFinite(value)||value<g.createdAt-3600000||value>now+3600000)throw new ArenaError(`Invalid ${label}.`);return Math.round(value);};
  const observationTime=stamp(args.observationTime,'observation time'),responseTime=stamp(args.responseTime,'response time'),executionTime=stamp(args.executionTime,'execution time'),round=args.round??0;
  if(!Number.isInteger(round)||round<0||round>9)throw new ArenaError('Round must be an integer from 0 to 9.');
  for(const [key,limit] of [['model',200],['reasoningEffort',40]] as const)if(args[key]!==undefined&&args[key]!==null&&(typeof args[key]!=='string'||args[key].length>limit))throw new ArenaError(`Invalid ${key}.`);
  if(args.actions!==undefined&&args.actions!==null&&(!Array.isArray(args.actions)||args.actions.length>16||JSON.stringify(args.actions).length>8000))throw new ArenaError('Invalid actions summary.');
  if(args.note!==undefined&&args.note!==null&&(typeof args.note!=='string'||args.note.length>600))throw new ArenaError('Invalid note; use up to 600 characters.');
  if(args.reasoning!==undefined&&args.reasoning!==null&&(typeof args.reasoning!=='string'||args.reasoning.length>100000))throw new ArenaError('Invalid reasoning; use up to 100,000 characters.');
  if(a.calls>=callLimit(g))throw new ArenaError('External telemetry limit reached.',429);
  a.calls++;a.latencySamples=(a.latencySamples??0)+1;a.latencyMs+=args.latencyMs;a.promptTokens+=args.inputTokens??0;a.completionTokens+=args.outputTokens??0;
  tx.record({agentId:a.id,decisionId:args.requestId,round,source:'self_reported',provider:'external',model:args.model??a.model??null,reasoningEffort:args.reasoningEffort??null,observationTime,responseTime,executionTime,llmMs:Math.round(args.latencyMs),executionMs:responseTime!==null&&executionTime!==null?executionTime-responseTime:null,stalenessMs:observationTime!==null&&executionTime!==null?executionTime-observationTime:null,promptTokens:args.inputTokens??0,completionTokens:args.outputTokens??0,late:false,actions:args.actions??null,note:args.note??null,reasoning:args.reasoning??null});
  const result={recorded:true};g.receipts.push({agentId:a.id,id:args.requestId,result});g.receipts=g.receipts.slice(-500);return result;});
 if(name==='get_results')return change(args.gameId,(g)=>{authenticate(g,args.token);return {status:g.status};});
 if(!['get_order_book','get_position','get_atlas_history','get_fills','place_order','cancel_order','cancel_all','wait'].includes(name))throw new ArenaError('Unknown MCP tool.',404);
 return change(args.gameId,(g,now)=>runAction(g,args.agentToken,{...args,action:name},now));
}
type Book={bestBid:number|null;bestAsk:number|null};
// One decision episode may spend up to DECISION_DEADLINE_MS on model calls (a 45 s call plus a short follow-up); the lease outlives it.
export const DECISION_DEADLINE_MS=65000,DECISION_LEASE_MS=80000;
const trimRules=leanSnapshot;
// Per-action outcome against the book the model actually saw, so a missed fill caused by a moved book is visible.
export function summarizeAction(action:Intent,outcome:{ok:boolean;result?:any;error?:string},observed:Book){
 const summary:Record<string,unknown>={action:action.action,ok:outcome.ok};
 if(action.action==='place_order'){
  const type=action.type??'limit',opposite=action.side==='buy'?observed.bestAsk:observed.bestBid;
  Object.assign(summary,{side:action.side,type,quantity:action.quantity,price:typeof action.price==='number'?action.price:null});
  const marketable=opposite!==null&&(type==='market'||(typeof action.price==='number'&&(action.side==='buy'?action.price>=opposite:action.price<=opposite)));
  summary.marketableAtObservation=marketable;
  if(outcome.ok&&outcome.result)Object.assign(summary,{orderId:outcome.result.orderId,status:outcome.result.status,filledQuantity:outcome.result.filledQuantity,averageFillPrice:outcome.result.averageFillPrice,missedFill:marketable&&!outcome.result.filledQuantity});
 }
 if(action.action==='cancel_order')summary.orderId=action.orderId;
 if(!outcome.ok)summary.error=outcome.error;
 return summary;
}
export async function decision(id:string,token:string,config:ModelConfig|undefined){
 if(config)endpoint(config);
 const leaseId=crypto.randomUUID();let step=1;
 const claim=await change(id,(g,now,journal)=>{
  const a=agentAuth(g,token);ensureRunning(g,now);
  if(a.provider==='external')throw new ArenaError('External agents should use the MCP or REST order endpoints.');
  if(a.preset&&config)throw new ArenaError('Arena-provided agents use their fixed server configuration.');
  if(a.provider!=='baseline'&&!a.preset&&(!config||config.provider!==a.provider||config.model!==a.model))throw new ArenaError('Provider and model must match the registered agent.');
  if(a.preset&&a.calls>=presetCallLimit(durationOf(g)))throw new ArenaError('This arena-provided agent reached its model-call limit.',429);
  if(a.calls>=callLimit(g))throw new ArenaError(`This agent reached the ${callLimit(g)}-call game limit.`,429);
  if(a.leaseUntil>now||now-a.lastDecision<Math.max(a.intervalMs??0,MIN_DECISION_GAP_MS))return {skipped:true} as const;
  const previousTurn=a.lastDecision;a.leaseId=leaseId;a.leaseUntil=now+DECISION_LEASE_MS;a.lastDecision=now;
  const observed=observation(g,a,now);
  // The model receives only the header; the full observation is available through the read tools.
  journal(a.id,leaseId,0,[{role:'user',content:JSON.stringify(headerSnapshot(observed,previousTurn))}],[config?.apiKey??'']);
  return {skipped:false,agentId:a.id,preset:a.preset,endsAt:g.endsAt!,rules:rulesFor(g),book:{bestBid:observed.book.bestBid,bestAsk:observed.book.bestAsk} as Book,actions:a.provider==='baseline'?baseline(g,a):null};
 });
 if(claim.result.skipped)return {...claim,result:{skipped:true}};
 const agentId=claim.result.agentId,deadline=Math.min(claim.result.endsAt,claim.state.now+DECISION_DEADLINE_MS);let totalActions=0,totalRounds=0,inferenceStarted=0,respondedAt=0;
 // Three server-clock stamps per round: the input (observation or previous tool results) time, the model reply time, and the execution time.
 let inputTime=claim.state.now,inputRevision=claim.revision,inputBook=claim.result.book;
 const beforeCall=async()=>{
  const checked=await change(id,(g,now)=>{const a=agentAuth(g,token);if(g.status!=='running'||a.leaseId!==leaseId||(a.preset&&a.calls>=presetCallLimit(durationOf(g)))||a.calls>=callLimit(g))return false;a.calls++;return true;});
  if(!checked.result)return false;
  if(claim.result.preset)await reserveDefaultCall();return true;
 };
 const commit=async(outcome:Completion,round=0)=>{
  const startStep=step;const messageCount=1+outcome.calls.length;
  const applied=await change(id,(g,now,journal,tx)=>{
   const a=agentAuth(g,token),late=g.status!=='running'||a.leaseId!==leaseId,before=orderBook(g);
   const results=outcome.calls.map((call,i)=>{if(late)return {action:call.intent.action,ok:false,error:'Game deadline or decision lease passed; action was not executed.'};try{return {action:call.intent.action,ok:true,result:trimRules(runAction(g,token,{...call.intent,requestId:leaseId+':'+startStep+':'+i},now))};}catch(e){a.errors++;const error=e instanceof ArenaError?e.message:'Trading action failed.';addEvent(g,now,a.id,'error',error);return {action:call.intent.action,ok:false,error};}});
   const others=partyLabels(g.agents,a.id);
   const replies:ChatMessage[]=results.map((result,i)=>({role:'tool',tool_call_id:outcome.calls[i].id,content:JSON.stringify(leanToolResult(result,others))}));
   // Read results are ephemeral: later turns replay a one-line reminder instead of the data.
   const replays=results.map((result,i)=>READ_TOOLS.has(outcome.calls[i].intent.action)&&result.ok?{role:'tool' as const,tool_call_id:outcome.calls[i].id,content:JSON.stringify(readSummary(outcome.calls[i].intent.action,result.result))}:null);
   journal(a.id,leaseId,startStep,[outcome.message,...replies],[config?.apiKey??''],[null,...replays]);
   if(!late){a.latencySamples=(a.latencySamples??0)+1;a.latencyMs+=outcome.latencyMs;a.promptTokens+=outcome.usage.promptTokens;a.completionTokens+=outcome.usage.completionTokens;addEvent(g,now,a.id,'decision',`${a.name} · ${outcome.calls.length} tool calls · ${outcome.latencyMs} ms · history retained`);}
   const responded=respondedAt||now;
   tx.record({agentId:a.id,decisionId:leaseId,round,source:'server',provider:a.provider,model:a.model??null,reasoningEffort:effectiveReasoningEffort(config),temperature:config?config.temperature??.3:null,maxTokens:config?config.maxTokens??512:null,observationTime:inputTime,responseTime:config?responded:null,executionTime:now,observationRevision:inputRevision,executionRevision:tx.revision,llmMs:config?outcome.latencyMs:null,executionMs:config?now-responded:null,stalenessMs:now-inputTime,casRetries:tx.attempt,promptTokens:outcome.usage.promptTokens,completionTokens:outcome.usage.completionTokens,observedBestBid:inputBook.bestBid,observedBestAsk:inputBook.bestAsk,executedBestBid:before.bestBid,executedBestAsk:before.bestAsk,bookMoved:inputBook.bestBid!==before.bestBid||inputBook.bestAsk!==before.bestAsk,late,actions:outcome.calls.map((call,i)=>summarizeAction(call.intent,results[i],inputBook)),note:config&&typeof outcome.message.content==='string'?outcome.message.content:null,reasoning:outcome.reasoning??null});
   const after=orderBook(g);return {replies,late,results,book:{bestBid:after.bestBid,bestAsk:after.bestAsk} as Book};
  });
  inferenceStarted=0;respondedAt=0;step+=messageCount;totalActions+=outcome.calls.length;totalRounds++;
  inputTime=applied.state.now;inputRevision=applied.revision;inputBook=applied.result.book;
  return applied.result;
 };
 try{
  if(claim.result.preset){const p=defaultAgent(claim.result.preset);if(!p||!env.SAIL_API_KEY)throw new ArenaError('The arena’s default Sail agents are unavailable. Add an agent with your own provider key.',503);config={provider:'sail',model:p.model,apiKey:env.SAIL_API_KEY,temperature:.3,maxTokens:p.maxTokens??DEFAULT_MAX_TOKENS,prompt:DEFAULT_STRATEGY,reasoningEffort:p.reasoningEffort};}
  if(claim.result.actions){if(await beforeCall())await commit(scriptedCompletion(claim.result.actions));}
  else{
   const messages=await replayMessages(id,agentId);
   const rules=claim.result.rules;
   await converse({messages,deadline,beforeCall,complete:async(history,remaining)=>{inferenceStarted=Date.now();const outcome=await complete(config!,history,remaining,undefined,rules);respondedAt=Date.now();return outcome;},commit});
  }
  const released=await change(id,(g)=>{const a=agentAuth(g,token);if(a.leaseId===leaseId){a.leaseId='';a.leaseUntil=0;}return {modelRounds:totalRounds,toolCalls:totalActions,historyMessages:a.historyMessages??0};});return released;
 }catch(error){
  const message=error instanceof ArenaError&&/timed out/.test(error.message)&&Date.now()>=claim.result.endsAt?'Game ended before the model replied; no action was executed.':error instanceof ArenaError?error.message:'Provider request failed.';
  await change(id,(g,now,journal,tx)=>{
   const a=agentAuth(g,token),late=g.status!=='running'||a.leaseId!==leaseId,elapsed=inferenceStarted?Date.now()-inferenceStarted:null;
   journal(a.id,leaseId,step,[{role:'user',content:JSON.stringify({kind:'provider_error',serverTime:now,error:message})}],[config?.apiKey??'']);
   tx.record({agentId:a.id,decisionId:leaseId,round:totalRounds,source:'server',provider:a.provider,model:a.model??null,reasoningEffort:effectiveReasoningEffort(config),temperature:config?config.temperature??.3:null,maxTokens:config?config.maxTokens??512:null,observationTime:inputTime,responseTime:null,executionTime:now,observationRevision:inputRevision,executionRevision:tx.revision,llmMs:elapsed,executionMs:null,stalenessMs:now-inputTime,casRetries:tx.attempt,promptTokens:0,completionTokens:0,observedBestBid:inputBook.bestBid,observedBestAsk:inputBook.bestAsk,late,actions:[{action:'provider_error',ok:false,error:message}]});
   if(!late){if(inferenceStarted){a.latencySamples=(a.latencySamples??0)+1;a.latencyMs+=Date.now()-inferenceStarted;}a.leaseId='';a.leaseUntil=0;a.errors++;addEvent(g,now,a.id,'error',message);}
   return {};
  });
  throw error;
 }
}

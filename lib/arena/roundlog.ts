// Human-readable round log: what every agent saw, said, and did, in order, with Atlas executions and the market
// state between decisions. Built from the public state, the stored transcripts, and the decision-metric rows.
import type {publicState} from './engine.ts';
import type {TranscriptEntry} from './conversation.ts';
import type {DecisionEntry} from './store.ts';
type State=ReturnType<typeof publicState>;
export type Trajectory={agentId:string;name:string;messages:TranscriptEntry[]};
type Event={time:number;order:number;lines:string[]};
const money=(n:unknown)=>typeof n==='number'&&Number.isFinite(n)?n.toFixed(2):'—';
const signed=(n:unknown)=>typeof n==='number'&&Number.isFinite(n)?(n>=0?'+':'')+n.toFixed(2):'—';
const qty=(n:unknown)=>typeof n==='number'&&Number.isFinite(n)?(n>0?'+':'')+String(n):'—';
// Scripted baseline turns put their action list in the assistant content; that is not reasoning worth quoting.
const isActionJson=(text:string)=>{const v=parse(text);return Array.isArray(v)||(!!v&&typeof v==='object'&&('action' in v||'actions' in v));};
const secs=(ms:unknown)=>typeof ms==='number'&&Number.isFinite(ms)?(ms/1000).toFixed(1)+' s':'—';
const clip=(s:unknown,n=400)=>{const t=String(s??'').replace(/\s+/g,' ').trim();return t.length>n?t.slice(0,n-1)+'…':t;};
const cell=(s:unknown)=>clip(s,160).replace(/\|/g,'\\|');
const parse=(text:string|null|undefined)=>{if(!text)return null;try{return JSON.parse(text);}catch{return null;}};
const mean=(xs:number[])=>xs.length?Math.round(xs.reduce((a,b)=>a+b,0)/xs.length):null;
function describeCall(name:string,args:Record<string,unknown>){
 if(name==='place_order')return `${name} ${args.side} ${args.quantity} ${args.type==='market'?'market':'@ '+money(Number(args.price))}`;
 if(name==='cancel_order')return `${name} ${args.orderId??''}`;
 if(name==='wait')return args.reason?`wait (${clip(args.reason,100)})`:'wait';
 return name;
}
function describeOutcome(r:any){
 if(!r||typeof r!=='object')return '';
 if(r.ok===false)return '✗ '+clip(r.error||'failed',160);
 const x=r.result;if(!x||typeof x!=='object')return '✓';
 if('filledQuantity' in x||'filled' in x){const filled=x.filledQuantity??x.filled,resting=x.remainingQuantity??x.resting,parts=[String(x.status??'')];if(filled)parts.push(`filled ${filled}${x.averageFillPrice!=null?' @ '+money(x.averageFillPrice):''}`);if(resting)parts.push(`${resting} resting`);if(x.canceledQuantity)parts.push(`${x.canceledQuantity} canceled`);return '✓ '+parts.filter(Boolean).join(', ');}
 if('canceled' in x)return `✓ canceled ${x.canceled}`;
 if(x.book)return '✓ market snapshot';
 if(x.position&&!x.book)return '✓ position read';
 return '✓ '+clip(x.status??'done',40);
}
function describeSummary(a:any){
 const head=a.action==='place_order'?`place_order ${a.side} ${a.quantity} ${a.type==='market'?'market':'@ '+money(Number(a.price))}`:a.action==='cancel_order'?`cancel_order ${a.orderId??''}`:String(a.action);
 if(a.ok===false)return `${head} → ✗ ${clip(a.error||'failed',160)}`;
 const parts=[];if(a.status)parts.push(String(a.status));if(a.filledQuantity)parts.push(`filled ${a.filledQuantity}${a.averageFillPrice!=null?' @ '+money(a.averageFillPrice):''}`);if(a.missedFill)parts.push('marketable when observed but missed');
 return `${head} → ✓${parts.length?' '+parts.join(', '):''}`;
}
export function roundLog({state,trajectories,decisions}:{state:State;trajectories:Trajectory[];decisions:DecisionEntry[]}){
 const start=state.startedAt??state.createdAt,rel=(t:number)=>'t+'+Math.max(0,(t-start)/1000).toFixed(1)+'s';
 const names=new Map<string,string>(state.agents.map(a=>[a.id,a.name]));names.set('$atlas','Atlas');
 const rowsFor=(id:string)=>decisions.filter(d=>d.agentId===id);
 const out:string[]=[];
 const atlas:any=state.atlas;
 out.push(`# Round log · ${state.id}`,'',[`${state.durationMs/1000} s round`,`seed ${state.seed}`,`status ${state.status}`,atlas.center!=null?`hidden center C = ${money(atlas.center)}`:'center hidden until the close',atlas.commitment?`commitment ${String(atlas.commitment).slice(0,16)}…${atlas.secret?' (secret revealed, replay with agents/verify_atlas.py)':''}`:'',`${state.agents.length} agents`,`Atlas ${atlas.ticks.length} ${state.status==='finished'?'arrivals':'executions so far'} / ${atlas.filledQuantity} contracts filled`,`volume ${state.volume}`].filter(Boolean).join(' · '),'');
 // Leaderboard
 out.push('## Final leaderboard'+(state.status==='finished'?'':' (provisional)'),'','| # | Agent | Model · effort | P&L | Realized | Position | Filled | Fill rate | Calls | Errors | LLM mean | Staleness mean |','|---|---|---|---|---|---|---|---|---|---|---|---|');
 for(const a of state.leaderboard){const rows=rowsFor(a.id),llm=rows.map(r=>r.llmMs).filter((x):x is number=>typeof x==='number'),st=rows.map(r=>r.stalenessMs).filter((x):x is number=>typeof x==='number'),effort=rows.find(r=>r.reasoningEffort)?.reasoningEffort;
  out.push(`| ${a.rank} | ${cell(a.name)} | ${cell((a.model??a.strategy??a.provider)+(effort?' · '+effort:''))} | ${signed(a.pnl)} | ${signed(a.realizedPnl)} | ${a.position>0?'+':''}${a.position} | ${a.filledQuantity} | ${(a.fillRate*100).toFixed(0)}% | ${a.calls} | ${a.errors} | ${llm.length?mean(llm)+' ms':'—'} | ${st.length?mean(st)+' ms':'—'} |`);}
 out.push('');
 // Observations across all transcripts, for market snapshots and P&L paths.
 const observations:{time:number;agentId:string;o:any}[]=[];
 for(const t of trajectories)for(const e of t.messages){if(e.message.role!=='user')continue;const o=parse(e.message.content);if(o&&o.book&&typeof o.serverTime==='number')observations.push({time:o.serverTime,agentId:t.agentId,o});}
 observations.sort((a,b)=>a.time-b.time);
 // Market timeline in a dozen buckets.
 const duration=state.durationMs,bucket=Math.max(5000,Math.round(duration/12/5000)*5000),end=state.endsAt??start+duration;
 out.push(`## Market timeline (every ${bucket/1000} s)`,'','| t | Last | Bid / Ask | Spread | Cum. volume | Atlas filled | Agent fills | Decisions | Errors |','|---|---|---|---|---|---|---|---|---|');
 for(let T=start+bucket,prev=start;T<=end+1;prev=T,T+=bucket){
  const last=[...state.series].filter(p=>p.time<=T).at(-1),snap=[...observations].filter(x=>x.time<=T).at(-1)?.o,ticks=atlas.ticks.filter((k:any)=>k.time>prev&&k.time<=T),agentFills=state.fills.filter(f=>f.time>prev&&f.time<=T&&f.taker!=='$atlas'&&f.maker!=='$atlas').length,dec=decisions.filter(d=>(d.executionTime??d.createdAt)>prev&&(d.executionTime??d.createdAt)<=T),errs=dec.filter(d=>(d.actions as any[]||[]).some(x=>x.ok===false||x.action==='provider_error')).length;
  out.push(`| ${rel(T)} | ${money(last?.price)} | ${money(snap?.book?.bestBid)} / ${money(snap?.book?.bestAsk)} | ${money(snap?.book?.spread)} | ${last?.volume??0} | ${ticks.reduce((s:number,k:any)=>s+(k.filledQuantity||0),0)} / ${ticks.length} arrivals | ${agentFills} | ${dec.length} | ${errs} |`);
 }
 out.push('');
 // Decision timeline, merged with Atlas arrivals.
 const events:Event[]=[],shown=new Set<string>(),hasTranscript=new Set<string>();
 for(const [i,k] of (atlas.ticks as any[]).entries()){
  const makers=[...new Set((k.executions||[]).map((x:any)=>names.get(x.maker)||x.maker))].join(', ');
  const text=k.filledQuantity>0?`**Atlas** ${k.side==='buy'?'buys':'sells'} ${k.filledQuantity}${k.requestedQuantity?'/'+k.requestedQuantity:''} @ ${money(k.averageFillPrice)}${k.limitPrice!=null?' (limit '+money(k.limitPrice)+')':''} from ${makers||'the book'}`:`**Atlas** ${k.side} ${k.requestedQuantity??''} at limit ${money(k.limitPrice)}: no fill (best ${k.side==='buy'?'ask':'bid'} ${money(k.bestAvailablePrice)})`;
  events.push({time:k.time,order:i,lines:[`- ${rel(k.time)} · ${text}`]});
 }
 for(const t of trajectories){
  const toolResults=new Map<string,any>();for(const e of t.messages)if(e.message.role==='tool'&&e.message.tool_call_id)toolResults.set(e.message.tool_call_id,parse(e.message.content));
  const rounds=new Map<string,number>();let lastObs:any=null,lastObsTime=0;hasTranscript.add(t.agentId);
  for(const e of t.messages){
   const m=e.message;
   if(m.role==='user'){const o=parse(m.content);if(o?.kind==='provider_error')events.push({time:e.time,order:1e6,lines:[`### ${rel(e.time)} · ${t.name} · provider error`,`${clip(o.error,300)}`]});else if(o?.book){lastObs=o;lastObsTime=o.serverTime??e.time;}continue;}
   if(m.role!=='assistant')continue;
   const round=rounds.get(e.decisionId)??0;rounds.set(e.decisionId,round+1);shown.add(`${t.agentId}|${e.decisionId}|${round}`);
   const row=decisions.find(d=>d.agentId===t.agentId&&d.decisionId===e.decisionId&&d.round===round);
   const meta=[row?.llmMs!=null?`LLM ${secs(row.llmMs)}`:'',row?.stalenessMs!=null?`staleness ${secs(row.stalenessMs)}`:'',row?.bookMoved?'book moved':'',row?.late?'LATE, not executed':''].filter(Boolean).join(' · ');
   const lines=[`### ${rel(e.time)} · ${t.name}${round?' · follow-up':''}${meta?' · '+meta:''}`];
   if(lastObs)lines.push(`Saw (${rel(lastObsTime)}): last ${money(lastObs.lastPrice)} · bid ${money(lastObs.book?.bestBid)} / ask ${money(lastObs.book?.bestAsk)} · position ${qty(lastObs.position?.position)} · P&L ${signed(lastObs.position?.pnl)} · ${lastObs.openOrders?.length??0} open orders · ${secs(lastObs.remainingMs)} left`);
   if(row?.reasoning)lines.push(`Thought: ${row.reasoning.replace(/\s*\n\s*/g,' ')}`);
   if(typeof m.content==='string'&&m.content.trim()&&!isActionJson(m.content))lines.push(`Said: ${clip(m.content,600)}`);
   if(m.tool_calls?.length){lines.push('Did:');for(const c of m.tool_calls){const args=parse(c.function.arguments)||{};lines.push(`- ${describeCall(c.function.name,args)} → ${describeOutcome(toolResults.get(c.id))}`);}}
   else lines.push('Did: nothing (no tool calls)');
   events.push({time:e.time,order:2e6,lines});
  }
 }
 // Rows without a transcript entry (external agents, or rounds whose transcript is missing) are narrated from the row itself.
 for(const d of decisions){if(shown.has(`${d.agentId}|${d.decisionId}|${d.round}`))continue;if(hasTranscript.has(d.agentId)&&(Array.isArray(d.actions)?d.actions:[]).some((x:any)=>x.action==='provider_error'))continue;const time=d.executionTime??d.createdAt,meta=[d.llmMs!=null?`LLM ${secs(d.llmMs)}`:'',d.stalenessMs!=null?`staleness ${secs(d.stalenessMs)}`:'',d.source==='self_reported'?'self-reported':''].filter(Boolean).join(' · ');
  const lines=[`### ${rel(time)} · ${names.get(d.agentId)||d.agentId}${d.round?' · follow-up':''}${meta?' · '+meta:''}`];
  if(d.observedBestBid!=null||d.observedBestAsk!=null)lines.push(`Saw: bid ${money(d.observedBestBid)} / ask ${money(d.observedBestAsk)}`);
  if(d.reasoning)lines.push(`Thought: ${d.reasoning.replace(/\s*\n\s*/g,' ')}`);
  if(d.note&&!isActionJson(d.note))lines.push(`Said: ${clip(d.note,600)}`);
  const acts=Array.isArray(d.actions)?d.actions:[];if(acts.length){lines.push('Did:');for(const a of acts)lines.push('- '+describeSummary(a));}else lines.push('Did: nothing reported');
  events.push({time,order:2e6,lines});}
 events.sort((a,b)=>a.time-b.time||a.order-b.order);
 out.push('## Decision timeline','',...(events.length?events.flatMap(e=>[...e.lines,'']):['No decisions were recorded.','']));
 // Per-agent summaries.
 out.push('## Agents','');
 for(const a of state.leaderboard){
  const t=trajectories.find(t=>t.agentId===a.id&&t.messages.some(e=>e.message.role==='assistant')),rows=rowsFor(a.id),counts=new Map<string,number>();
  if(t){for(const e of t.messages)if(e.message.role==='assistant')for(const c of e.message.tool_calls||[])counts.set(c.function.name,(counts.get(c.function.name)||0)+1);}
  else for(const d of rows)for(const x of (Array.isArray(d.actions)?d.actions:[]) as any[])counts.set(String(x.action),(counts.get(String(x.action))||0)+1);
  const path=observations.filter(x=>x.agentId===a.id&&typeof x.o.position?.pnl==='number').map(x=>({time:x.time,pnl:x.o.position.pnl as number}));
  const peak=path.length?path.reduce((m,p)=>p.pnl>m.pnl?p:m):null,trough=path.length?path.reduce((m,p)=>p.pnl<m.pnl?p:m):null;
  const llm=rows.map(r=>r.llmMs).filter((x):x is number=>typeof x==='number'),st=rows.map(r=>r.stalenessMs).filter((x):x is number=>typeof x==='number'),missed=rows.reduce((n,d)=>n+((Array.isArray(d.actions)?d.actions:[]) as any[]).filter(x=>x.missedFill).length,0),providerErrors=rows.filter(d=>((Array.isArray(d.actions)?d.actions:[]) as any[]).some(x=>x.action==='provider_error')).length,late=rows.filter(d=>d.late).length,moved=rows.filter(d=>d.bookMoved).length;
  out.push(`### ${a.name}`,'',`- ${a.model??a.strategy??a.provider}${rows.find(r=>r.reasoningEffort)?.reasoningEffort?' · reasoning '+rows.find(r=>r.reasoningEffort)!.reasoningEffort:''} · ${a.calls} calls · ${rows.length} decision rounds · ${a.historyMessages} history messages · ${a.promptTokens} / ${a.completionTokens} tokens`,
   `- Actions: ${[...counts.entries()].map(([k,v])=>`${k} ×${v}`).join(', ')||'none'}`,
   `- Fills: ${a.fills} (${a.makerFills} maker / ${a.takerFills} taker), ${a.filledQuantity} contracts, fill rate ${(a.fillRate*100).toFixed(0)}%, ${a.cancellations} cancels, ${a.expiredOrders} expired at the close`,
   `- Result: P&L ${signed(a.pnl)} (realized ${signed(a.realizedPnl)}, unrealized ${signed(a.unrealizedPnl)}), final position ${a.position>0?'+':''}${a.position}${a.averageEntry!=null?' @ avg '+money(a.averageEntry):''}, peak position ${a.peakPosition}, score drawdown ${money(a.maxDrawdown)}`+(peak&&trough?`; live P&L peaked ${signed(peak.pnl)} at ${rel(peak.time)} and bottomed ${signed(trough.pnl)} at ${rel(trough.time)}`:''),
   `- Timing: LLM mean ${llm.length?mean(llm)+' ms':'—'}${llm.length?' (max '+Math.max(...llm)+' ms)':''}, staleness mean ${st.length?mean(st)+' ms':'—'}${st.length?' (max '+Math.max(...st)+' ms)':''}, book moved before execution in ${moved}/${rows.length} rounds, ${missed} marketable orders missed, ${providerErrors} provider errors, ${late} late rounds, ${a.errors} rejected actions`,'');
 }
 out.push('---','Generated by Market Arena. Transcripts exclude credentials. "Thought" is the model’s hidden reasoning (reasoning_content), recorded in full for analysis but never replayed to the model; "Said" is the visible text it returned with its tool calls.');
 return out.join('\n');
}

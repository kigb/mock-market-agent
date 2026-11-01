import {ArenaError,type Intent} from './engine.ts';
// Model-facing view of a market snapshot: the static rules are in the system prompt, the account is reduced to its trading
// view, orders and fills are compact, and every Atlas execution so far is kept. REST/MCP observations keep every field.
export function leanSnapshot<T>(value:T):T{
 if(!value||typeof value!=='object'||!('book' in value))return value;
 const o=value as any,me=o.position?.id,who=(id:unknown)=>id==='$atlas'?'Atlas':id===me?'you':'other';
 const {rules:_rules,position,openOrders,recentFills,atlas,...rest}=o;
 const ticks=atlas&&Array.isArray(atlas.ticks)?atlas.ticks.map((t:any)=>Array.isArray(t.executions)?{...t,executions:t.executions.map((x:any)=>({...x,maker:who(x.maker)}))}:t):undefined;
 return {...rest,...(atlas?{atlas:ticks?{...atlas,ticks}:atlas}:{}),
  // Only the trading view of the account; the full statistics stay in REST, the leaderboard, and the export.
  ...(position?{position:{position:position.position,cash:position.cash,pnl:position.pnl,realizedPnl:position.realizedPnl,unrealizedPnl:position.unrealizedPnl,averageEntry:position.averageEntry}}:{}),
  ...(Array.isArray(openOrders)?{openOrders:openOrders.map((x:any)=>({id:x.id,side:x.side,price:x.price,quantity:x.quantity}))}:{}),
  ...(Array.isArray(recentFills)?{recentFills:recentFills.map((f:any)=>({time:f.time,side:f.side,price:f.price,quantity:f.quantity,taker:who(f.taker),maker:who(f.maker)}))}:{})} as T;
}
// Model-facing tool result: an order outcome shrinks to what the next decision needs; read tools return lean snapshots.
export function leanToolResult<T extends {ok:boolean;result?:any}>(entry:T):T{
 if(!entry.ok||!entry.result||typeof entry.result!=='object')return entry;
 const r=entry.result;
 if('filledQuantity' in r)return {...entry,result:{orderId:r.orderId,status:r.status,filled:r.filledQuantity,...(r.filledQuantity?{averageFillPrice:r.averageFillPrice}:{}),...(r.remainingQuantity?{resting:r.remainingQuantity}:{})}};
 if('book' in r)return {...entry,result:leanSnapshot(r)};
 return entry;
}
export type ToolCall={id:string;type:'function';function:{name:string;arguments:string}};
export type ChatMessage={role:'user'|'assistant'|'tool';content:string|null;tool_calls?:ToolCall[];tool_call_id?:string};
// reasoning is the provider's hidden chain of thought (reasoning_content). It is kept for analysis only: never replayed
// to the model and never stored in the conversation.
export type Completion={message:ChatMessage;calls:{id:string;intent:Intent}[];reasoning?:string;latencyMs:number;usage:{promptTokens:number;completionTokens:number}};
export type TranscriptEntry={id:number;time:number;decisionId:string;step:number;message:ChatMessage};
export function normalizeCompletion(data:any):Pick<Completion,'message'|'calls'|'reasoning'>{
 const m=data?.choices?.[0]?.message;if(!m)throw new ArenaError('The provider returned no completion message.');
 const hidden=[m.reasoning_content,m.reasoning,m.thinking].find(v=>typeof v==='string'&&v.trim());const reasoning=typeof hidden==='string'?hidden.trim().slice(0,100000):undefined;
 let toolCalls:ToolCall[]=[];
 if(Array.isArray(m.tool_calls)&&m.tool_calls.length){
  if(m.tool_calls.length>16)throw new ArenaError('The model returned too many tool calls.');
  const used=new Set<string>();
  toolCalls=m.tool_calls.map((t:any)=>{let id=typeof t.id==='string'&&t.id.length<=200?t.id:'call_'+crypto.randomUUID();if(used.has(id))id='call_'+crypto.randomUUID();used.add(id);return {id,type:'function',function:{name:String(t.function?.name||''),arguments:typeof t.function?.arguments==='string'?t.function.arguments:'{}'}};});
 }else if(typeof m.content==='string'&&m.content.trim()){
  const raw=m.content.trim().replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,'');let decoded:any;
  try{decoded=JSON.parse(raw);}catch{/* Visible prose is a completed turn. */}
  const list=Array.isArray(decoded)?decoded:Array.isArray(decoded?.actions)?decoded.actions:decoded&&(decoded.action||decoded.name)?[decoded]:[];
  if(list.length>16)throw new ArenaError('The model returned too many actions.');
  toolCalls=list.map((item:any)=>{const {action,name,...args}=item;return {id:'call_'+crypto.randomUUID(),type:'function',function:{name:action||name,arguments:JSON.stringify(args)}};});
 }else throw new ArenaError('The model produced no trading decision (possibly exhausted its token budget).');
 const calls=toolCalls.map(t=>{let args:any;try{args=JSON.parse(t.function.arguments);}catch{return {id:t.id,intent:{action:'invalid_tool_arguments'} as unknown as Intent};}if(!args||typeof args!=='object'||Array.isArray(args))return {id:t.id,intent:{action:'invalid_tool_arguments'} as unknown as Intent};return {id:t.id,intent:{...args,action:t.function.name} as Intent};});
 return {message:{role:'assistant',content:typeof m.content==='string'?m.content:null,...(toolCalls.length?{tool_calls:toolCalls}:{})},calls,...(reasoning?{reasoning}:{})};
}
export function scriptedCompletion(actions:Intent[]):Completion{return {...normalizeCompletion({choices:[{message:{content:JSON.stringify(actions)}}]}),latencyMs:0,usage:{promptTokens:0,completionTokens:0}};}
export function redactMessage(message:ChatMessage,secrets:string[]):ChatMessage{function visit(value:any,key=''):any{if(typeof value==='string'){if(key==='role'||key==='type')return value;for(const secret of secrets)if(secret)value=value.replaceAll(secret,'[redacted]');return value;}if(Array.isArray(value))return value.map(v=>visit(v));if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,visit(v,k)]));return value;}return visit(message);}
// Keep every prior message. A read-only tool turn may immediately lead to a trading turn.
export async function converse(options:{messages:ChatMessage[];deadline:number;now?:()=>number;beforeCall:(round:number)=>Promise<boolean>;complete:(messages:ChatMessage[],remainingMs:number)=>Promise<Completion>;commit:(completion:Completion,budget:number,round:number)=>Promise<{replies:ChatMessage[];late?:boolean}>}){
 const now=options.now??Date.now,messages=[...options.messages];let used=0,rounds=0,late=false;
 for(let round=0;round<2&&now()<options.deadline;round++){
  if(!await options.beforeCall(round))break;
  const remaining=options.deadline-now();if(remaining<=0)break;
  const completion=await options.complete(messages,remaining),result=await options.commit(completion,4-used,round);
  rounds++;messages.push(completion.message,...result.replies);late=!!result.late;
  used+=Math.min(completion.calls.length,4-used);
  if(late||!completion.calls.length||used>=4||completion.calls.some(c=>!['get_rules','get_order_book','get_position'].includes(c.intent.action)))break;
 }
 return {rounds,used,late};
}

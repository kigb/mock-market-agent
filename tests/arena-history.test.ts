import test from 'node:test';
import assert from 'node:assert/strict';
import {complete} from '../lib/arena/providers.ts';
import {converse,headerSnapshot,leanSnapshot,leanToolResult,normalizeCompletion,READ_TOOLS,readSummary,redactMessage,replayView,type ChatMessage,type Completion,type TranscriptEntry} from '../lib/arena/conversation.ts';
import {createGame,startGame,intent,observation} from '../lib/arena/engine.ts';
const config={provider:'sail' as const,model:'fixture',apiKey:'TEST_PROVIDER_SECRET'};
const tool=(id:string,name:string,args:object)=>({id,type:'function',function:{name,arguments:JSON.stringify(args)}});

test('a read tool gets its result back, then the model trades with its entire earlier conversation intact',async()=>{
 const g=createGame('game_history','host','',[{name:'Memory agent',provider:'external'},{name:'Counterparty',provider:'external'}],1000);startGame(g,2000);
 intent(g,g.agents[1],{action:'place_order',side:'sell',type:'limit',quantity:3,price:17.23},2001);
 const prior:ChatMessage[]=[{role:'user',content:'Remember: compare order outcomes before replacing quotes.'},{role:'assistant',content:null,tool_calls:[tool('earlier','wait',{reason:'Waiting for a quote'}) as any]},{role:'tool',tool_call_id:'earlier',content:'{"ok":true,"result":{"status":"waiting"}}'},{role:'user',content:JSON.stringify(observation(g,g.agents[0],2002))}];
 const requests:any[]=[];
 const fetcher:typeof fetch=async(_url,init)=>{const body=JSON.parse(init!.body as string);requests.push(body);return Response.json({choices:[{message:{content:null,tool_calls:requests.length===1?[tool('read-book','get_order_book',{})]:[tool('buy-contracts','place_order',{side:'buy',type:'market',quantity:2})]}}],usage:{prompt_tokens:12,completion_tokens:3}});};
 const records:ChatMessage[]=[];
 const result=await converse({messages:prior,deadline:Date.now()+10000,beforeCall:async()=>true,complete:(messages,remaining)=>complete(config,messages,remaining,fetcher),commit:async(outcome)=>{
  const replies:ChatMessage[]=outcome.calls.map(c=>({role:'tool',tool_call_id:c.id,content:JSON.stringify({ok:true,result:c.intent.action==='get_order_book'?observation(g,g.agents[0],2003):intent(g,g.agents[0],c.intent,2004)})}));records.push(outcome.message,...replies);return {replies};
 }});
 assert.equal(result.rounds,2);assert.equal(g.agents[0].position,2);assert.equal(g.agents[0].cash,-3446);
 assert.deepEqual(requests[1].messages.slice(1,1+prior.length),prior);assert.equal(requests[1].messages.at(-1).tool_call_id,'read-book');assert.equal(JSON.parse(requests[1].messages.at(-1).content).result.book.bestAsk,17.23);
 assert.equal(records.at(-1)?.tool_call_id,'buy-contracts');assert.equal(JSON.parse(records.at(-1)!.content!).result.filledQuantity,2);
 assert.ok(!JSON.stringify(requests[1].messages).includes(config.apiKey));
});
test('model snapshots drop the rules and slim the account, orders, and fills while keeping every Atlas execution',()=>{
 const g=createGame('game_lean','host','',[{name:'A',provider:'external'},{name:'B',provider:'external'}],1000);startGame(g,2000);
 const o:any=observation(g,g.agents[0],2001);o.atlas.ticks=Array.from({length:45},(_,i)=>({time:2000+i,side:'buy',filledQuantity:1,averageFillPrice:50,executions:[]}));
 intent(g,g.agents[1],{action:'place_order',side:'sell',type:'limit',quantity:3,price:40},2001);intent(g,g.agents[0],{action:'place_order',side:'buy',type:'limit',quantity:5,price:40},2002);intent(g,g.agents[0],{action:'place_order',side:'buy',type:'limit',quantity:2,price:39},2003);
 const full:any=observation(g,g.agents[0],2004);full.atlas.ticks=o.atlas.ticks.map((t:any,i:number)=>({...t,executions:[{price:50,quantity:1,maker:i%2?g.agents[0].id:g.agents[1].id}]}));const lean:any=leanSnapshot(full);
 assert.deepEqual(lean.atlas.ticks.slice(0,2).map((t:any)=>t.executions[0].maker),['other','you'],'Atlas execution makers are labelled');assert.equal(full.atlas.ticks[0].executions[0].maker,g.agents[1].id,'original untouched');
 assert.ok(!('rules' in lean));assert.equal(lean.atlas.ticks.length,45,'every Atlas execution is kept');assert.equal(lean.atlas.ticks[0].time,2000);assert.ok(!('recentTicks' in lean.atlas));assert.equal(lean.book.bestBid,full.book.bestBid);assert.equal(full.atlas.ticks.length,45,'the original observation is untouched');
 assert.deepEqual(Object.keys(lean.position).sort(),['averageEntry','cash','pnl','position','realizedPnl','unrealizedPnl']);assert.equal(lean.position.position,3);assert.ok(!('calls' in lean.position)&&!('promptTokens' in lean.position));
 assert.deepEqual(lean.openOrders,[{id:full.openOrders[0].id,side:'buy',price:40,quantity:2},{id:full.openOrders[1].id,side:'buy',price:39,quantity:2}]);assert.ok(!('agentId' in lean.openOrders[0]));
 assert.deepEqual(lean.recentFills.map((f:any)=>[f.side,f.price,f.quantity,f.taker,f.maker]),[['buy',40,3,'you','other']]);assert.ok(!('id' in lean.recentFills[0]));
 assert.ok(!JSON.stringify(lean).includes(g.agents[1].id),'no counterparty ids');assert.ok(JSON.stringify(lean).length<JSON.stringify(full).length-JSON.stringify(full.rules).length,'lean view is smaller than the full observation minus rules');
 assert.deepEqual(leanSnapshot({position:1}),{position:1});assert.equal(leanSnapshot(null),null);
 const order:any=leanToolResult({action:'place_order',ok:true,result:{orderId:'ord_9',filledQuantity:2,remainingQuantity:3,canceledQuantity:0,averageFillPrice:40,status:'partially_filled'}});
 assert.deepEqual(order.result,{orderId:'ord_9',status:'partially_filled',filled:2,averageFillPrice:40,resting:3});
 assert.deepEqual(leanToolResult({action:'place_order',ok:true,result:{orderId:'ord_1',filledQuantity:0,remainingQuantity:0,canceledQuantity:4,averageFillPrice:null,status:'unfilled'}}).result,{orderId:'ord_1',status:'unfilled',filled:0});
 assert.deepEqual(leanToolResult({action:'cancel_all',ok:true,result:{status:'canceled',canceled:2}}).result,{status:'canceled',canceled:2});assert.deepEqual(leanToolResult({action:'wait',ok:false,error:'late'}),{action:'wait',ok:false,error:'late'});
 assert.ok(!('rules' in leanToolResult({action:'get_order_book',ok:true,result:full}).result));
});
test('the per-turn header is minimal, read results are ephemeral on replay, and decisions allow three rounds',async()=>{
 const g=createGame('game_header','host','',[{name:'A',provider:'external'},{name:'B',provider:'external'}],1000);startGame(g,2000);
 intent(g,g.agents[1],{action:'place_order',side:'sell',type:'limit',quantity:3,price:40},2001);intent(g,g.agents[0],{action:'place_order',side:'buy',type:'limit',quantity:2,price:39},2002);
 const o:any=observation(g,g.agents[0],5000);o.atlas.ticks=[{time:3000,side:'buy',filledQuantity:2,averageFillPrice:40,executions:[]},{time:4500,side:'sell',filledQuantity:1,averageFillPrice:39,executions:[]}];
 const h=headerSnapshot(o,3500);assert.deepEqual(h,{serverTime:5000,remainingMs:177000,lastPrice:null,bestBid:39,bestAsk:40,position:0,pnl:0,openOrders:1,atlasFillsSinceLastTurn:1,atlasFillsTotal:2});assert.ok(JSON.stringify(h).length<220);
 assert.deepEqual([...READ_TOOLS].sort(),['get_atlas_history','get_fills','get_order_book','get_position','get_rules']);
 const summary=readSummary('get_atlas_history',{total:40,ticks:[{},{},{}]});assert.equal(summary.ephemeral,true);assert.match(summary.note,/Viewed 3 Atlas executions/);assert.match(readSummary('get_order_book',leanSnapshot(o)).note,/order book \(2 levels\), your 1 open orders/);
 const entries:TranscriptEntry[]=[{id:1,time:1,decisionId:'d',step:0,message:{role:'user',content:'{}'}},{id:2,time:2,decisionId:'d',step:1,message:{role:'assistant',content:null,tool_calls:[tool('r','get_fills',{}) as any]}},{id:3,time:3,decisionId:'d',step:2,message:{role:'tool',tool_call_id:'r',content:'{"fills":[1,2,3]}'},replay:{role:'tool',tool_call_id:'r',content:'{"ephemeral":true}'}},{id:4,time:4,decisionId:'d',step:3,message:{role:'tool',tool_call_id:'x',content:'{"orderId":"ord_1"}'},replay:null}];
 const replayed=replayView(entries);assert.equal(replayed[2].content,'{"ephemeral":true}');assert.equal(replayed[2].tool_call_id,'r','tool linkage survives');assert.equal(replayed[3].content,'{"orderId":"ord_1"}');assert.equal(entries[2].message.content,'{"fills":[1,2,3]}','the transcript keeps the data');
 let calls=0;const reads=():Completion=>({...normalizeCompletion({choices:[{message:{tool_calls:[tool('r'+calls,'get_atlas_history',{})]}}]}),latencyMs:0,usage:{promptTokens:0,completionTokens:0}});
 await converse({messages:[],deadline:100,now:()=>0,beforeCall:async()=>true,complete:async()=>{calls++;return reads();},commit:async(c)=>({replies:c.calls.map(x=>({role:'tool',tool_call_id:x.id,content:'{}'}))})});
 assert.equal(calls,3,'three rounds when every round is a read');
});
test('long round histories retain the first message and all intermediate outcomes',async()=>{
 const messages:ChatMessage[]=Array.from({length:180},(_,i)=>({role:'user',content:JSON.stringify({sequence:i})}));let received:any;
 const done=await complete(config,messages,1000,async(_url,init)=>{received=JSON.parse(init!.body as string);return Response.json({choices:[{message:{content:'I will keep the current quotes.'}}]});});
 assert.equal(received.messages.length,181);assert.equal(received.messages[1].content,'{"sequence":0}');assert.equal(received.messages.at(-1).content,'{"sequence":179}');assert.equal(done.calls.length,0);
});
test('tool IDs survive replay, duplicate IDs are repaired, and visible prose ends a turn',()=>{
 const parsed=normalizeCompletion({choices:[{message:{content:'Checking inventory.',reasoning_content:'  Hidden reasoning stays out of the replayed history.\n',tool_calls:[tool('same','get_position',{}),tool('same','get_order_book',{})]}}]});
 assert.equal(parsed.calls[0].id,'same');assert.notEqual(parsed.calls[1].id,'same');assert.equal(parsed.message.tool_calls![1].id,parsed.calls[1].id);
 // The hidden reasoning is captured for the analysis table but never enters the conversation message that is replayed.
 assert.equal(parsed.reasoning,'Hidden reasoning stays out of the replayed history.');assert.ok(!JSON.stringify(parsed.message).includes('Hidden reasoning'));
 assert.equal(normalizeCompletion({choices:[{message:{content:'Plain.',reasoning:'alt field'}}]}).reasoning,'alt field');assert.equal(normalizeCompletion({choices:[{message:{content:'Plain.',reasoning_content:'   '}}]}).reasoning,undefined);
 assert.equal(normalizeCompletion({choices:[{message:{content:'No additional action this turn.'}}]}).calls.length,0);
 const bad=normalizeCompletion({choices:[{message:{tool_calls:[{id:'invalid',function:{name:'place_order',arguments:'{broken'}}]}}]});assert.equal(bad.calls[0].id,'invalid');assert.equal(bad.calls[0].intent.action,'invalid_tool_arguments');
});
test('information loops stop at the three-round cap and never start inference past the deadline',async()=>{
 let calls=0,commits=0;
 const fake=():Completion=>({...normalizeCompletion({choices:[{message:{tool_calls:[tool('r'+calls,'get_position',{}),tool('b'+calls,'get_order_book',{})]}}]}),latencyMs:0,usage:{promptTokens:0,completionTokens:0}});
 await converse({messages:[],deadline:100,now:()=>0,beforeCall:async()=>true,complete:async()=>{calls++;return fake();},commit:async(o,round)=>{commits++;assert.equal(round,commits-1);return {replies:o.calls.map(c=>({role:'tool',tool_call_id:c.id,content:'{}'}))};}});
 assert.equal(calls,3);assert.equal(commits,3);
 await converse({messages:[],deadline:100,now:()=>100,beforeCall:async()=>{throw Error('must not run');},complete:async()=>fake(),commit:async()=>({replies:[]})});
});
test('persisted conversations redact actual credentials without changing tool IDs or roles',()=>{
 const message:ChatMessage={role:'assistant',content:'TEST_PROVIDER_SECRET should be removed',tool_calls:[tool('safe-call','wait',{reason:'agent-private-token'}) as any]};
 const safe=redactMessage(message,['TEST_PROVIDER_SECRET','agent-private-token']);assert.equal(safe.role,'assistant');assert.equal(safe.tool_calls![0].id,'safe-call');assert.ok(!JSON.stringify(safe).includes('TEST_PROVIDER_SECRET'));assert.ok(!JSON.stringify(safe).includes('agent-private-token'));assert.ok(JSON.stringify(safe).includes('[redacted]'));
});


test('a provider context limit is explicit and never discards conversation history',async()=>{
 const messages:ChatMessage[]=[{role:'user',content:'First observation must remain.'}];
 await assert.rejects(()=>complete(config,messages,1000,async()=>Response.json({error:{code:'context_length_exceeded',message:'input exceeds safe limit'}},{status:400})),(e:Error)=>/full conversation is retained/.test(e.message));
 assert.equal(messages.length,1);assert.equal(messages[0].content,'First observation must remain.');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {complete} from '../lib/arena/providers.ts';
import {converse,normalizeCompletion,redactMessage,type ChatMessage,type Completion} from '../lib/arena/conversation.ts';
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
test('long round histories retain the first message and all intermediate outcomes',async()=>{
 const messages:ChatMessage[]=Array.from({length:180},(_,i)=>({role:'user',content:JSON.stringify({sequence:i})}));let received:any;
 const done=await complete(config,messages,1000,async(_url,init)=>{received=JSON.parse(init!.body as string);return Response.json({choices:[{message:{content:'I will keep the current quotes.'}}]});});
 assert.equal(received.messages.length,181);assert.equal(received.messages[1].content,'{"sequence":0}');assert.equal(received.messages.at(-1).content,'{"sequence":179}');assert.equal(done.calls.length,0);
});
test('tool IDs survive replay, duplicate IDs are repaired, and visible prose ends a turn',()=>{
 const parsed=normalizeCompletion({choices:[{message:{content:'Checking inventory.',reasoning_content:'Do not store hidden reasoning.',tool_calls:[tool('same','get_position',{}),tool('same','get_order_book',{})]}}]});
 assert.equal(parsed.calls[0].id,'same');assert.notEqual(parsed.calls[1].id,'same');assert.equal(parsed.message.tool_calls![1].id,parsed.calls[1].id);assert.ok(!JSON.stringify(parsed).includes('hidden reasoning'));
 assert.equal(normalizeCompletion({choices:[{message:{content:'No additional action this turn.'}}]}).calls.length,0);
 const bad=normalizeCompletion({choices:[{message:{tool_calls:[{id:'invalid',function:{name:'place_order',arguments:'{broken'}}]}}]});assert.equal(bad.calls[0].id,'invalid');assert.equal(bad.calls[0].intent.action,'invalid_tool_arguments');
});
test('information loops stop at their call/action budget and never start inference past the deadline',async()=>{
 let calls=0,commits=0;
 const fake=():Completion=>({...normalizeCompletion({choices:[{message:{tool_calls:[tool('r'+calls,'get_position',{}),tool('b'+calls,'get_order_book',{})]}}]}),latencyMs:0,usage:{promptTokens:0,completionTokens:0}});
 await converse({messages:[],deadline:100,now:()=>0,beforeCall:async()=>true,complete:async()=>{calls++;return fake();},commit:async(o,budget)=>{commits++;assert.equal(budget,commits===1?4:2);return {replies:o.calls.map(c=>({role:'tool',tool_call_id:c.id,content:'{}'}))};}});
 assert.equal(calls,2);assert.equal(commits,2);
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

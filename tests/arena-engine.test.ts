import test from 'node:test';
import assert from 'node:assert/strict';
import {createGame,startGame,addAgent,intent,advance,observation,orderBook,pnl,publicState,sorted,valuation,match,BOT_INTERVAL_MS,ArenaError} from '../lib/arena/engine.ts';
import {baseline,endpoint,infer,parseDecision} from '../lib/arena/providers.ts';
import {MODEL_TOOLS,MCP_TOOLS} from '../lib/arena/protocol.ts';
function fixture(){const g=createGame('game_00000000-0000-0000-0000-000000000000','host','owner',[{name:'Alice',provider:'external'},{name:'Bob',provider:'external'}],1000,42);startGame(g,2000);return g;}
const place=(g:any,i:number,side:'buy'|'sell',quantity:number,price?:number,requestId?:string)=>intent(g,g.agents[i],{action:'place_order',side,type:price===undefined?'market':'limit',quantity,price},2001,requestId);
test('starts empty with exactly one non-competing system bot and zero portfolios',()=>{const g=fixture();assert.equal(g.agents.length,3);assert.equal(g.agents.at(-1)?.id,'$atlas');assert.equal(g.orders.length,0);assert.ok(g.agents.every(a=>!a.cash&&!a.position));assert.equal(orderBook(g).bestBid,null);advance(g,4000);assert.equal(g.fills.length,0);assert.equal(g.botAttempts,0);assert.equal(g.orders.length,0);advance(g,12000);assert.equal(g.botAttempts,1);assert.equal(g.fills.length,0);});
test('FIFO matching, price sweeps, partial fills, and residual order IDs',()=>{const g=fixture();place(g,1,'sell',2,51);place(g,1,'sell',2,50);place(g,1,'sell',3,50);const result:any=place(g,0,'buy',6);assert.equal(result.filledQuantity,6);assert.ok(Math.abs(result.averageFillPrice-301/6)<1e-10);assert.deepEqual(g.fills.map(f=>[f.price,f.quantity]),[[5000,2],[5000,3],[5100,1]]);assert.equal(g.orders[0].quantity,1);assert.equal(g.agents[0].position,6);assert.equal(g.agents[0].cash,-30100);});
test('long/short accounting, zero-price and 100-price boundaries',()=>{const g=fixture();place(g,1,'buy',10,50);place(g,0,'sell',10);assert.equal(g.agents[0].position,-10);assert.equal(g.agents[0].cash,50000);place(g,1,'sell',15,49);place(g,0,'buy',15);assert.equal(g.agents[0].position,5);assert.equal(g.agents[0].realized,1000);assert.equal(g.agents[0].average,4900);assert.equal(pnl(g.agents[0]),1000);const h=fixture();place(h,1,'sell',1,0);place(h,0,'buy',1);place(h,1,'buy',1,100);place(h,0,'sell',1);assert.equal(h.agents[0].realized,10000);assert.equal(h.fills[0].price,0);assert.equal(h.fills[1].price,10000);});
test('unfilled market quantity cancels; limit residual rests; cancellation enforces ownership',()=>{const g=fixture();place(g,1,'sell',2,50);const a:any=place(g,0,'buy',5);assert.equal(a.canceledQuantity,3);assert.equal(a.remainingQuantity,0);assert.equal(g.orders.length,0);const b:any=place(g,0,'buy',3,49);assert.equal(b.status,'open');assert.equal(g.orders[0].id,b.orderId);assert.throws(()=>intent(g,g.agents[1],{action:'cancel_order',orderId:b.orderId},2010));intent(g,g.agents[0],{action:'cancel_order',orderId:b.orderId},2010);assert.equal(g.orders.length,0);});
test('self-match prevention cancels resting quote and duplicate request executes once',()=>{const g=fixture();place(g,0,'sell',5,49);place(g,1,'sell',5,50);place(g,0,'buy',2,undefined,'same-id');place(g,0,'buy',2,undefined,'same-id');assert.equal(g.agents[0].position,2);assert.equal(g.fills.length,1);assert.equal(g.agents[0].cancellations,1);assert.equal(g.orders[0].agentId,g.agents[1].id);});
test('server closes exactly at 60s; all six 10-second Atlas ticks run even after idle; final scores freeze',()=>{const g=fixture();place(g,0,'buy',500,49.95);place(g,0,'sell',500,50.05);advance(g,61999);assert.equal(g.status,'running');assert.equal(g.botAttempts,5);advance(g,62000);assert.equal(g.status,'finished');assert.equal(g.finishedAt,62000);assert.equal(g.botAttempts,6);assert.equal(g.orders.length,0);const score=JSON.stringify(g.agents);advance(g,999999);assert.equal(JSON.stringify(g.agents),score);assert.throws(()=>place(g,0,'buy',1));assert.equal(g.agents[0].expired,2);const h=fixture();advance(h,80000);assert.equal(h.botAttempts,6);assert.equal(h.status,'finished');assert.equal(h.fills.length,0);});
test('no opening price or synthetic history; only executions establish the market',()=>{
 const g=fixture();assert.equal(g.lastPrice,null);assert.equal(g.series.length,0);assert.equal(publicState(g,2001).lastPrice,null);assert.equal(observation(g,g.agents[0],2001).lastPrice,null);assert.equal(publicState(g,2001).settlementPrice,null);
 place(g,1,'sell',2,17.23);assert.equal(g.lastPrice,null);assert.equal(g.series.length,0);place(g,0,'buy',1);assert.equal(g.lastPrice,1723);assert.equal(g.series[0].price,17.23);assert.equal(g.series[0].volume,1);assert.equal(g.series.length,1);assert.equal(pnl(g.agents[0]),0);
});
test('realized scoring ignores open cash, price pushes, and unsold inventory',()=>{
 const g=fixture();g.schema=3;place(g,1,'sell',10,20);place(g,0,'buy',10);assert.equal(pnl(g.agents[0]),0);assert.equal(pnl(g.agents[1]),0);
 place(g,1,'buy',4,30);place(g,0,'sell',4);assert.equal(pnl(g.agents[0]),4000);assert.equal(g.agents[0].position,6);
 place(g,1,'sell',1,99);place(g,0,'buy',1);assert.equal(g.lastPrice,9900);assert.equal(pnl(g.agents[0]),4000);assert.equal(publicState(g,2001).agents[0].pnl,40);assert.equal(publicState(g,2001).agents[0].entryNotional,219);assert.equal(publicState(g,2001).scoringMode,'realized');advance(g,62000);assert.equal(publicState(g,62000).agents[0].pnl,40);
});
test('historical schema-2 rounds retain original scoring and bot timing',()=>{
 const g=fixture();g.schema=2;g.lastPrice=5000;place(g,1,'sell',1,40);place(g,0,'buy',1);const s=publicState(g,2001);assert.equal(s.scoringMode,'legacy_fixed');assert.equal(s.agents[0].pnl,10);assert.equal(s.botIntervalMs,1000);assert.equal(s.settlementPrice,50);advance(g,62000);assert.equal(g.botAttempts,60);assert.equal(BOT_INTERVAL_MS,10000);
});
test('bounds, quantities, unique names and action limits',()=>{for(const p of [-.01,100.01,.001,NaN]){const g=fixture();assert.throws(()=>place(g,0,'buy',1,p));}for(const q of [0,-1,1001,1.5,NaN]){const g=fixture();assert.throws(()=>place(g,0,'buy',q,50));}const g=fixture();for(let i=0;i<20;i++)place(g,0,'buy',1,49);assert.throws(()=>place(g,0,'buy',1,49),(e:any)=>e.status===429);assert.throws(()=>addAgent(g,{name:'Late',provider:'external'},'c','c',3000));assert.throws(()=>createGame('g','h','o',[{name:'Atlas',provider:'external'}],0));assert.throws(()=>createGame('g','h','o',[{name:'A',provider:'external'},{name:'a',provider:'external'}],0));});
test('observations, state, and model schemas never contain session credentials',()=>{const g=fixture();const a=g.agents[0];const text=JSON.stringify({state:publicState(g,2001),observation:observation(g,a,2001)});assert.ok(!text.includes(a.token));assert.ok(!text.includes('hostToken'));for(const t of MODEL_TOOLS){assert.ok(!('agentToken' in t.function.parameters.properties));assert.ok(!('gameId' in t.function.parameters.properties));}assert.ok(MCP_TOOLS.find(t=>t.name==='place_order'));});
test('baseline strategies create genuine liquidity and trade through normal intents',()=>{const g=fixture();g.agents[0].strategy='maker';g.agents[1].strategy='momentum';for(let ms=2001;ms<62000;ms+=2000){advance(g,ms);for(const a of g.agents.slice(0,2)){for(const i of baseline(g,a))intent(g,a,i,ms);}}advance(g,62000);assert.equal(g.status,'finished');assert.ok(g.volume>0);assert.equal(g.agents.reduce((v,a)=>v+a.position,0),0);assert.equal(g.agents.reduce((v,a)=>v+a.cash,0),0);for(const a of g.agents)assert.ok(Math.abs(a.cash+a.position*a.average-a.realized)<.000001);});
test('2,000 randomized orders preserve cash, inventory, and book invariants',()=>{const g=createGame('g','h','o',Array.from({length:4},(_,i)=>({name:'Agent'+i,provider:'external' as const})),1000,42);startGame(g,2000);let seed=19;const rand=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/2**32;};for(let i=0;i<2000;i++){const a=g.agents[i%4],now=2001+Math.floor(i/40)*1000;if(now>=62000)break;advance(g,now);intent(g,a,{action:'cancel_all'},now);intent(g,a,{action:'place_order',type:rand()>.2?'limit':'market',side:rand()>.5?'buy':'sell',quantity:1+Math.floor(rand()*10),price:Math.floor(rand()*10001)/100},now);assert.equal(g.agents.reduce((v,a)=>v+a.cash,0),0);assert.equal(g.agents.reduce((v,a)=>v+a.position,0),0);const b=sorted(g,'buy')[0],ask=sorted(g,'sell')[0];if(b&&ask)assert.ok(b.price<ask.price);assert.ok(g.orders.every(o=>o.quantity>0));}});
test('provider endpoints use verified URLs and reject unsafe Modal targets',()=>{const c={provider:'sail' as const,model:'test',apiKey:'secret'};assert.equal(endpoint(c),'https://api.sailresearch.com/v1/chat/completions');assert.equal(endpoint({...c,provider:'fireworks'}),'https://api.fireworks.ai/inference/v1/chat/completions');assert.equal(endpoint({...c,provider:'modal',baseUrl:'https://my-app.modal.run/v1/'}),'https://my-app.modal.run/v1/chat/completions');for(const u of ['http://my.modal.run/v1','https://localhost/v1','https://my.modal.run.evil.com/v1','https://my.modal.run/v1?token=x','https://user:pass@my.modal.run/v1'])assert.throws(()=>endpoint({...c,provider:'modal',baseUrl:u}));});
test('model tool calls and JSON fallback parse; malformed output is visible, not silent',()=>{const parsed=parseDecision({choices:[{message:{tool_calls:[{function:{name:'place_order',arguments:'{"side":"buy","type":"limit","quantity":2,"price":49.9}'}}]}}]});assert.equal(parsed[0].action,'place_order');assert.equal(parsed[0].quantity,2);assert.equal(parseDecision({choices:[{message:{content:'```json\n{"action":"wait"}\n```'}}]})[0].action,'wait');assert.throws(()=>parseDecision({choices:[{message:{content:'I will buy!'}}]}));});
test('provider integration fixture checks auth, tools, usage and safe errors without paid calls',async()=>{const g=fixture(),a=g.agents[0],seen:any[]=[];const mock:typeof fetch=async(url,init)=>{seen.push({url,init});return Response.json({choices:[{message:{tool_calls:[{function:{name:'wait',arguments:'{}'}}]}}],usage:{prompt_tokens:42,completion_tokens:8}});};const c={provider:'sail' as const,model:'fixture-model',apiKey:'FAKE_KEY_FOR_TEST'};const out=await infer(c,observation(g,a,2001),1000,mock);assert.equal(out.actions[0].action,'wait');assert.equal(out.usage.promptTokens,42);assert.equal(seen[0].init.headers.Authorization,'Bearer FAKE_KEY_FOR_TEST');assert.ok(seen[0].init.body.includes('tools'));assert.ok(seen[0].init.body.includes('50% best-first / 50% worst-first'));assert.ok(seen[0].init.body.includes('Only Atlas can bypass normal price priority'));assert.ok(!seen[0].init.body.includes(a.token));await assert.rejects(()=>infer(c,{},1000,async()=>new Response('do not leak FAKE_KEY_FOR_TEST',{status:401})),(e:any)=>e.status===502&&!e.message.includes('FAKE_KEY_FOR_TEST'));});

test('eight provided presets pin models and intervals, reject duplicates and exclude credentials',async()=>{
 const {DEFAULT_AGENTS}=await import('../lib/arena/presets.ts');
 assert.equal(DEFAULT_AGENTS.length,8);
 const specs=DEFAULT_AGENTS.map(a=>({...a}));
 const g=createGame('preset-fixture','host','',specs,1000);
 assert.equal(g.agents.filter(a=>a.preset).length,8);
 assert.equal(new Set(g.agents.filter(a=>a.preset).map(a=>a.model)).size,5);
 for(const p of DEFAULT_AGENTS){
  assert.equal(g.agents.find(a=>a.preset===p.preset)?.intervalMs,4000);
  assert.throws(()=>createGame('x','h','',[{...p,model:'arbitrary-model'}],1000));
  assert.throws(()=>createGame('x','h','',[{...p,intervalMs:500}],1000));
  assert.throws(()=>createGame('x','h','',[{...p},{...p,name:'Duplicate'}],1000));
 }
 assert.throws(()=>createGame('x','h','',[{...specs[0],preset:'untrusted'}],1000));
 assert.ok(!JSON.stringify(publicState(g,1000)).includes('apiKey'));
});

test('Sail uses native token limits and explicit latency/reasoning controls',async()=>{
 let body:any;
 await infer({provider:'sail',model:'zai-org/GLM-5.3',apiKey:'TEST_ONLY',maxTokens:1536,reasoningEffort:'low'}, {},12000,async(_url,init)=>{body=JSON.parse(init!.body as string);return Response.json({choices:[{message:{tool_calls:[{function:{name:'wait',arguments:'{}'}}]}}]});});
 assert.equal(body.max_completion_tokens,1536);
 assert.equal(body.metadata.completion_window,'asap');
 assert.equal(body.reasoning_effort,'low');
 assert.equal(body.max_tokens,undefined);
});

test('provider transport does not follow redirects and redacts credentials from diagnostics',async()=>{
 const c={provider:'sail' as const,model:'fixture',apiKey:'PRIVATE_TEST_CREDENTIAL'};
 let redirectMode:RequestRedirect|undefined;
 await assert.rejects(()=>infer(c,{},1000,async(_url,init)=>{redirectMode=init?.redirect;return new Response('',{status:307,headers:{Location:'https://other.example'}});}));
 assert.equal(redirectMode,'manual');
 const messages:unknown[]=[];const original=console.error;console.error=(...args:unknown[])=>messages.push(args);
 try{await assert.rejects(()=>infer(c,{},1000,async()=>{throw new Error('fetch failed with '+c.apiKey);}));}finally{console.error=original;}
 assert.ok(!JSON.stringify(messages).includes(c.apiKey));
 assert.ok(JSON.stringify(messages).includes('[redacted]'));
});


test('closing midpoint values inventory, preserves components, and freezes before order expiry',()=>{
 const g=fixture();place(g,1,'sell',10,20);place(g,0,'buy',10);place(g,1,'buy',1000,30);place(g,1,'sell',1000,40);
 const live=publicState(g,2001);assert.equal(live.scoringMode,'closing_midpoint');assert.equal(live.valuation.price,35);assert.equal(live.valuation.source,'midpoint');assert.equal(live.settlementPrice,null);assert.equal(live.agents[0].pnl,150);assert.equal(live.agents[0].realizedPnl,0);assert.equal(live.agents[0].unrealizedPnl,150);
 advance(g,62000);const final=publicState(g,62000);assert.equal(g.orders.length,0);assert.equal(final.settlementPrice,35);assert.equal(final.valuation.frozen,true);assert.equal(final.valuation.bestBid,30);assert.equal(final.valuation.bestAsk,40);assert.equal(final.agents[0].pnl,150);assert.equal(final.atlas.attempts,6);
 g.lastPrice=9900;advance(g,999999);const later=publicState(g,999999);assert.deepEqual(later.valuation,final.valuation);assert.deepEqual(later.leaderboard,final.leaderboard);assert.ok(Math.abs([...final.agents,final.atlas].reduce((v,a)=>v+a.pnl,0))<1e-8);
});
test('midpoint retains half-tick precision and supports a zero best bid',()=>{
 const g=fixture();place(g,1,'buy',1000,0);place(g,1,'sell',1000,.01);assert.equal(g.lastPrice,null);assert.equal(publicState(g,2001).valuation.price,.005);assert.equal(g.series.length,0);advance(g,62000);assert.equal(publicState(g,62000).settlementPrice,.005);
});
test('one-sided or empty book falls back to last execution, including a zero-price trade',()=>{
 const g=fixture();place(g,1,'sell',1,0);place(g,0,'buy',1);place(g,0,'sell',10,99);const s=publicState(g,2001);assert.equal(s.valuation.price,0);assert.equal(s.valuation.source,'last_trade');intent(g,g.agents[0],{action:'cancel_all'},2002);advance(g,62000);const f=publicState(g,62000);assert.equal(f.settlementPrice,0);assert.equal(f.valuation.source,'last_trade');
 const h=fixture();advance(h,62000);const empty=publicState(h,62000);assert.equal(empty.settlementPrice,null);assert.equal(empty.valuation.source,'unpriced');assert.ok(empty.agents.every(a=>a.pnl===0));assert.equal(empty.lastPrice,null);
});
test('total marked P&L equals realized plus unrealized without double-counting cash',()=>{
 const g=fixture();place(g,1,'sell',10,20);place(g,0,'buy',10);place(g,1,'buy',4,30);place(g,0,'sell',4);const a=publicState(g,2001).agents[0];assert.equal(a.realizedPnl,40);assert.equal(a.unrealizedPnl,60);assert.equal(a.cash,-80);assert.equal(a.position,6);assert.equal(a.pnl,100);assert.equal(a.pnl,a.realizedPnl+a.unrealizedPnl!);
});
test('an unexecuted quote may move a midpoint mark without changing the trade chart',()=>{
 const g=fixture();place(g,1,'sell',10,20);place(g,0,'buy',10);place(g,1,'buy',1000,20);place(g,1,'sell',1000,40);const volume=g.volume,points=g.series.length;assert.equal(publicState(g,2001).valuation.price,30);place(g,0,'buy',1,39.99);const s=publicState(g,2001);assert.equal(s.valuation.price,39.995);assert.equal(s.agents[0].pnl,199.95);assert.equal(g.volume,volume);assert.equal(g.series.length,points);assert.equal(s.lastPrice,20);
});


test('Atlas best/worst buys select opposite extremes, cap total fills, and retain FIFO at equal prices',()=>{
 const g=fixture(),atlas=g.agents.at(-1)!;
 place(g,1,'sell',100,10);place(g,1,'sell',2,99);place(g,0,'sell',2,99);place(g,1,'sell',1,100);
 const result=match(g,atlas,'buy','market',5,null,3000,'worst');
 assert.equal(result.filledQuantity,5);assert.deepEqual(g.fills.map(f=>[f.price,f.quantity,f.maker,f.botSelection]),[[10000,1,g.agents[1].id,'worst'],[9900,2,g.agents[1].id,'worst'],[9900,2,g.agents[0].id,'worst']]);
 assert.equal(orderBook(g).bestAsk,10);assert.equal(g.orders[0].quantity,100);
 assert.equal(g.agents.reduce((n,a)=>n+a.cash,0),0);assert.equal(g.agents.reduce((n,a)=>n+a.position,0),0);
 const h=fixture(),a=h.agents.at(-1)!;place(h,0,'sell',100,99);place(h,1,'sell',100,100);
 match(h,a,'buy','market',1,null,3000,'best');match(h,a,'buy','market',1,null,3001,'worst');assert.deepEqual(h.fills.map(f=>f.price),[9900,10000]);
 assert.throws(()=>match(h,a,'buy','market',6,null,3002,'worst'),/1–5/);
});
test('Atlas worst sells take lowest bids first with FIFO and no liquidity creation',()=>{
 const g=fixture();place(g,1,'buy',100,90);place(g,1,'buy',2,1);place(g,0,'buy',2,1);place(g,1,'buy',1,0);
 match(g,g.agents.at(-1)!,'sell','market',5,null,3000,'worst');assert.deepEqual(g.fills.map(f=>[f.price,f.quantity,f.maker]),[[0,1,g.agents[1].id],[100,2,g.agents[1].id],[100,2,g.agents[0].id]]);assert.equal(orderBook(g).bestBid,90);assert.equal(g.orders[0].quantity,100);
 const h=fixture();const r=match(h,h.agents.at(-1)!,'sell','market',5,null,3000,'worst');assert.equal(r.filledQuantity,0);assert.equal(r.canceledQuantity,5);assert.equal(h.orders.length,0);assert.equal(h.lastPrice,null);
});
test('ordinary agents cannot request worst-first matching and marketable limits still take the best price',()=>{
 const g=fixture();place(g,1,'sell',10,10);place(g,1,'sell',10,100);
 assert.throws(()=>match(g,g.agents[0],'buy','market',1,null,3000,'worst'),/Only Atlas/);
 place(g,0,'buy',1,100);assert.equal(g.fills[0].price,1000);assert.equal(g.fills[0].botSelection,undefined);
});
test('Atlas records all six reproducible 50/50 selections with capped executions and final trace freezes',()=>{
 function round(){const g=fixture();place(g,0,'buy',1000,1);place(g,1,'buy',1000,40);place(g,0,'sell',1000,60);place(g,1,'sell',1000,99);advance(g,62000);return g;}
 const g=round(),h=round(),s=publicState(g,62000);assert.equal(g.schema,5);assert.equal(s.atlas.executionMode,'best_worst_50_50');assert.equal(s.atlas.ticks.length,6);assert.ok(s.atlas.bestAttempts>0&&s.atlas.worstAttempts>0);assert.equal(s.atlas.bestAttempts+s.atlas.worstAttempts,6);
 assert.deepEqual(g.botTicks!.map(({executions,...tick})=>tick),h.botTicks!.map(({executions,...tick})=>tick));
 for(const t of s.atlas.ticks){assert.ok(t.requestedQuantity>=1&&t.requestedQuantity<=5);assert.ok(t.filledQuantity<=t.requestedQuantity);assert.equal(t.filledQuantity+t.canceledQuantity,t.requestedQuantity);assert.equal(t.executions.reduce((q,f)=>q+f.quantity,0),t.filledQuantity);assert.equal(t.executions[0].price,t.selection==='best'?t.bestAvailablePrice:t.worstAvailablePrice);assert.equal(t.time%10000,2000);}
 assert.equal(s.atlas.bestFilledQuantity+s.atlas.worstFilledQuantity,s.atlas.filledQuantity);assert.equal(s.rules.botBestProbability,.5);assert.equal(s.rules.botWorstProbability,.5);assert.match(observation(g,g.agents[0],62000).rules.bot,/worst-first/);
 const before=JSON.stringify(s.atlas);advance(g,999999);assert.equal(JSON.stringify(publicState(g,999999).atlas),before);
});
test('schema-4 midpoint rounds retain best-only Atlas, their old random sequence, and frozen valuation',()=>{
 const g=fixture();g.schema=4;place(g,0,'buy',1000,1);place(g,1,'buy',1000,40);place(g,0,'sell',1000,60);place(g,1,'sell',1000,99);advance(g,62000);const s=publicState(g,62000);assert.equal(s.scoringMode,'closing_midpoint');assert.equal(s.valuation.price,50);assert.equal(s.atlas.executionMode,'best');assert.equal(s.atlas.bestAttempts,6);assert.equal(s.atlas.worstAttempts,0);assert.equal(s.rules.botWorstProbability,0);assert.ok(g.fills.every(f=>f.price===4000||f.price===6000));assert.deepEqual(g.fills.map(f=>[f.side,f.quantity]),[['sell',1],['buy',2],['sell',1],['sell',1],['buy',5],['buy',3]]);
});

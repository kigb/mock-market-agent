import test from 'node:test';
import assert from 'node:assert/strict';
import {createGame,startGame,addAgent,intent,advance,observation,orderBook,pnl,publicState,sorted,valuation,match,BOT_INTERVAL_MS,ArenaError,atlasCommitment,atlasStream,replayAtlas,atlasArrivalCap,callLimit,durationOf,MIN_DECISION_GAP_MS,RULES} from '../lib/arena/engine.ts';
import {presetCallLimit} from '../lib/arena/presets.ts';
import {createHash} from 'node:crypto';
import {baseline,complete,endpoint,infer,parseDecision} from '../lib/arena/providers.ts';
import {MODEL_TOOLS,MCP_TOOLS,SYSTEM_PROMPT,systemPrompt} from '../lib/arena/protocol.ts';
// Fixtures use explicit 60-second rounds so the deadline arithmetic below stays readable; new games default to 180 s.
function fixture(){const g=createGame('game_00000000-0000-0000-0000-000000000000','host','owner',[{name:'Alice',provider:'external'},{name:'Bob',provider:'external'}],1000,42,undefined,60_000);startGame(g,2000);return g;}
// Schema-5 rounds keep the 10-second best/worst Atlas and midpoint settlement.
function fixture5(){const g=fixture();g.schema=5;return g;}
const place=(g:any,i:number,side:'buy'|'sell',quantity:number,price?:number,requestId?:string)=>intent(g,g.agents[i],{action:'place_order',side,type:price===undefined?'market':'limit',quantity,price},2001,requestId);
test('starts empty with exactly one non-competing system bot and zero portfolios',()=>{const g=fixture5();assert.equal(g.agents.length,3);assert.equal(g.agents.at(-1)?.id,'$atlas');assert.equal(g.orders.length,0);assert.ok(g.agents.every(a=>!a.cash&&!a.position));assert.equal(orderBook(g).bestBid,null);advance(g,4000);assert.equal(g.fills.length,0);assert.equal(g.botAttempts,0);assert.equal(g.orders.length,0);advance(g,12000);assert.equal(g.botAttempts,1);assert.equal(g.fills.length,0);});
test('FIFO matching, price sweeps, partial fills, and residual order IDs',()=>{const g=fixture();place(g,1,'sell',2,51);place(g,1,'sell',2,50);place(g,1,'sell',3,50);const result:any=place(g,0,'buy',6);assert.equal(result.filledQuantity,6);assert.ok(Math.abs(result.averageFillPrice-301/6)<1e-10);assert.deepEqual(g.fills.map(f=>[f.price,f.quantity]),[[5000,2],[5000,3],[5100,1]]);assert.equal(g.orders[0].quantity,1);assert.equal(g.agents[0].position,6);assert.equal(g.agents[0].cash,-30100);});
test('long/short accounting, zero-price and 100-price boundaries',()=>{const g=fixture();place(g,1,'buy',10,50);place(g,0,'sell',10);assert.equal(g.agents[0].position,-10);assert.equal(g.agents[0].cash,50000);place(g,1,'sell',15,49);place(g,0,'buy',15);assert.equal(g.agents[0].position,5);assert.equal(g.agents[0].realized,1000);assert.equal(g.agents[0].average,4900);assert.equal(pnl(g.agents[0]),1000);const h=fixture();place(h,1,'sell',1,0);place(h,0,'buy',1);place(h,1,'buy',1,100);place(h,0,'sell',1);assert.equal(h.agents[0].realized,10000);assert.equal(h.fills[0].price,0);assert.equal(h.fills[1].price,10000);});
test('unfilled market quantity cancels; limit residual rests; cancellation enforces ownership',()=>{const g=fixture();place(g,1,'sell',2,50);const a:any=place(g,0,'buy',5);assert.equal(a.canceledQuantity,3);assert.equal(a.remainingQuantity,0);assert.equal(g.orders.length,0);const b:any=place(g,0,'buy',3,49);assert.equal(b.status,'open');assert.equal(g.orders[0].id,b.orderId);assert.throws(()=>intent(g,g.agents[1],{action:'cancel_order',orderId:b.orderId},2010));intent(g,g.agents[0],{action:'cancel_order',orderId:b.orderId},2010);assert.equal(g.orders.length,0);});
test('self-match prevention cancels resting quote and duplicate request executes once',()=>{const g=fixture();place(g,0,'sell',5,49);place(g,1,'sell',5,50);place(g,0,'buy',2,undefined,'same-id');place(g,0,'buy',2,undefined,'same-id');assert.equal(g.agents[0].position,2);assert.equal(g.fills.length,1);assert.equal(g.agents[0].cancellations,1);assert.equal(g.orders[0].agentId,g.agents[1].id);});
test('server closes exactly at 60s; all six 10-second Atlas ticks run even after idle; final scores freeze',()=>{const g=fixture5();place(g,0,'buy',500,49.95);place(g,0,'sell',500,50.05);advance(g,61999);assert.equal(g.status,'running');assert.equal(g.botAttempts,5);advance(g,62000);assert.equal(g.status,'finished');assert.equal(g.finishedAt,62000);assert.equal(g.botAttempts,6);assert.equal(g.orders.length,0);const score=JSON.stringify(g.agents);advance(g,999999);assert.equal(JSON.stringify(g.agents),score);assert.throws(()=>place(g,0,'buy',1));assert.equal(g.agents[0].expired,2);const h=fixture5();advance(h,80000);assert.equal(h.botAttempts,6);assert.equal(h.status,'finished');assert.equal(h.fills.length,0);});
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
test('2,000 randomized orders preserve cash, inventory, and book invariants',()=>{const g=createGame('g','h','o',Array.from({length:4},(_,i)=>({name:'Agent'+i,provider:'external' as const})),1000,42,undefined,60_000);startGame(g,2000);let seed=19;const rand=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/2**32;};for(let i=0;i<2000;i++){const a=g.agents[i%4],now=2001+Math.floor(i/40)*1000;if(now>=62000)break;advance(g,now);intent(g,a,{action:'cancel_all'},now);intent(g,a,{action:'place_order',type:rand()>.2?'limit':'market',side:rand()>.5?'buy':'sell',quantity:1+Math.floor(rand()*10),price:Math.floor(rand()*10001)/100},now);assert.equal(g.agents.reduce((v,a)=>v+a.cash,0),0);assert.equal(g.agents.reduce((v,a)=>v+a.position,0),0);const b=sorted(g,'buy')[0],ask=sorted(g,'sell')[0];if(b&&ask)assert.ok(b.price<ask.price);assert.ok(g.orders.every(o=>o.quantity>0));}});
test('provider endpoints use verified URLs and reject unsafe Modal targets',()=>{const c={provider:'sail' as const,model:'test',apiKey:'secret'};assert.equal(endpoint(c),'https://api.sailresearch.com/v1/chat/completions');assert.equal(endpoint({...c,provider:'fireworks'}),'https://api.fireworks.ai/inference/v1/chat/completions');assert.equal(endpoint({...c,provider:'modal',baseUrl:'https://my-app.modal.run/v1/'}),'https://my-app.modal.run/v1/chat/completions');for(const u of ['http://my.modal.run/v1','https://localhost/v1','https://my.modal.run.evil.com/v1','https://my.modal.run/v1?token=x','https://user:pass@my.modal.run/v1'])assert.throws(()=>endpoint({...c,provider:'modal',baseUrl:u}));});
test('model tool calls and JSON fallback parse; malformed output is visible, not silent',()=>{const parsed=parseDecision({choices:[{message:{tool_calls:[{function:{name:'place_order',arguments:'{"side":"buy","type":"limit","quantity":2,"price":49.9}'}}]}}]});assert.equal(parsed[0].action,'place_order');assert.equal(parsed[0].quantity,2);assert.equal(parseDecision({choices:[{message:{content:'```json\n{"action":"wait"}\n```'}}]})[0].action,'wait');assert.throws(()=>parseDecision({choices:[{message:{content:'I will buy!'}}]}));});
test('provider integration fixture checks auth, tools, usage and safe errors without paid calls',async()=>{const g=fixture(),a=g.agents[0],seen:any[]=[];const mock:typeof fetch=async(url,init)=>{seen.push({url,init});return Response.json({choices:[{message:{tool_calls:[{function:{name:'wait',arguments:'{}'}}]}}],usage:{prompt_tokens:42,completion_tokens:8}});};const c={provider:'sail' as const,model:'fixture-model',apiKey:'FAKE_KEY_FOR_TEST'};const out=await infer(c,observation(g,a,2001),1000,mock);assert.equal(out.actions[0].action,'wait');assert.equal(out.usage.promptTokens,42);assert.equal(seen[0].init.headers.Authorization,'Bearer FAKE_KEY_FOR_TEST');assert.ok(seen[0].init.body.includes('tools'));assert.ok(seen[0].init.body.includes('a limit price uniformly within C ± 5.00'),'the Atlas mechanism is stated in the rules');assert.equal((seen[0].init.body.match(/within C ± 5\.00/g)||[]).length,1,'and only once');assert.ok(seen[0].init.body.includes('quotes cannot move it'));assert.ok(!seen[0].init.body.includes(a.token));await assert.rejects(()=>infer(c,{},1000,async()=>new Response('do not leak FAKE_KEY_FOR_TEST',{status:401})),(e:any)=>e.status===502&&!e.message.includes('FAKE_KEY_FOR_TEST'));});

test('six provided presets span speeds with one large-model control, pin models and intervals, reject duplicates and exclude credentials',async()=>{
 const {DEFAULT_AGENTS}=await import('../lib/arena/presets.ts');
 assert.equal(DEFAULT_AGENTS.length,6);assert.ok(!DEFAULT_AGENTS.some(a=>/gemma/i.test(a.model)),'no Gemma slots');
 const specs=DEFAULT_AGENTS.map(a=>({...a}));
 const g=createGame('preset-fixture','host','',specs,1000);
 assert.equal(g.agents.filter(a=>a.preset).length,6);
 assert.equal(new Set(g.agents.filter(a=>a.preset).map(a=>a.model)).size,4);
 assert.deepEqual(DEFAULT_AGENTS.filter(a=>/GLM-5\.3$|Kimi|Pro/.test(a.model)).map(a=>a.preset),['sail-glm-low','sail-glm-medium','sail-deepseek-pro'],'large-model controls');assert.deepEqual(DEFAULT_AGENTS.filter(a=>a.model==='zai-org/GLM-5.3').map(a=>a.reasoningEffort),['low','medium']);
 assert.ok(!DEFAULT_AGENTS.some(a=>a.model.startsWith('zai-org/')&&a.reasoningEffort==='none'),'Sail rejects reasoning_effort none for GLM');
 assert.deepEqual(DEFAULT_AGENTS.filter(a=>a.model==='zai-org/GLM-5.3-Flash').map(a=>a.reasoningEffort),['low','medium']);
 for(const p of DEFAULT_AGENTS){
  assert.equal(g.agents.find(a=>a.preset===p.preset)?.intervalMs,0);
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
 const g=fixture5();place(g,1,'sell',10,20);place(g,0,'buy',10);place(g,1,'buy',1000,30);place(g,1,'sell',1000,40);
 const live=publicState(g,2001);assert.equal(live.scoringMode,'closing_midpoint');assert.equal(live.valuation.price,35);assert.equal(live.valuation.source,'midpoint');assert.equal(live.settlementPrice,null);assert.equal(live.agents[0].pnl,150);assert.equal(live.agents[0].realizedPnl,0);assert.equal(live.agents[0].unrealizedPnl,150);
 advance(g,62000);const final=publicState(g,62000);assert.equal(g.orders.length,0);assert.equal(final.settlementPrice,35);assert.equal(final.valuation.frozen,true);assert.equal(final.valuation.bestBid,30);assert.equal(final.valuation.bestAsk,40);assert.equal(final.agents[0].pnl,150);assert.equal(final.atlas.attempts,6);
 g.lastPrice=9900;advance(g,999999);const later=publicState(g,999999);assert.deepEqual(later.valuation,final.valuation);assert.deepEqual(later.leaderboard,final.leaderboard);assert.ok(Math.abs([...final.agents,final.atlas].reduce((v,a)=>v+a.pnl,0))<1e-8);
});
test('midpoint retains half-tick precision and supports a zero best bid',()=>{
 const g=fixture5();place(g,1,'buy',1000,0);place(g,1,'sell',1000,.01);assert.equal(g.lastPrice,null);assert.equal(publicState(g,2001).valuation.price,.005);assert.equal(g.series.length,0);advance(g,62000);assert.equal(publicState(g,62000).settlementPrice,.005);
});
test('one-sided or empty book falls back to last execution, including a zero-price trade',()=>{
 const g=fixture5();place(g,1,'sell',1,0);place(g,0,'buy',1);place(g,0,'sell',10,99);const s=publicState(g,2001);assert.equal(s.valuation.price,0);assert.equal(s.valuation.source,'last_trade');intent(g,g.agents[0],{action:'cancel_all'},2002);advance(g,62000);const f=publicState(g,62000);assert.equal(f.settlementPrice,0);assert.equal(f.valuation.source,'last_trade');
 const h=fixture5();advance(h,62000);const empty=publicState(h,62000);assert.equal(empty.settlementPrice,null);assert.equal(empty.valuation.source,'unpriced');assert.ok(empty.agents.every(a=>a.pnl===0));assert.equal(empty.lastPrice,null);
});
test('total marked P&L equals realized plus unrealized without double-counting cash',()=>{
 const g=fixture();place(g,1,'sell',10,20);place(g,0,'buy',10);place(g,1,'buy',4,30);place(g,0,'sell',4);const a=publicState(g,2001).agents[0];assert.equal(a.realizedPnl,40);assert.equal(a.unrealizedPnl,60);assert.equal(a.cash,-80);assert.equal(a.position,6);assert.equal(a.pnl,100);assert.equal(a.pnl,a.realizedPnl+a.unrealizedPnl!);
});
test('an unexecuted quote may move a midpoint mark without changing the trade chart',()=>{
 const g=fixture();place(g,1,'sell',10,20);place(g,0,'buy',10);place(g,1,'buy',1000,20);place(g,1,'sell',1000,40);const volume=g.volume,points=g.series.length;assert.equal(publicState(g,2001).valuation.price,30);place(g,0,'buy',1,39.99);const s=publicState(g,2001);assert.equal(s.valuation.price,39.995);assert.equal(s.agents[0].pnl,199.95);assert.equal(g.volume,volume);assert.equal(g.series.length,points);assert.equal(s.lastPrice,20);
});


test('Atlas best/worst buys select opposite extremes, cap total fills, and retain FIFO at equal prices',()=>{
 const g=fixture5(),atlas=g.agents.at(-1)!;
 place(g,1,'sell',100,10);place(g,1,'sell',2,99);place(g,0,'sell',2,99);place(g,1,'sell',1,100);
 const result=match(g,atlas,'buy','market',5,null,3000,'worst');
 assert.equal(result.filledQuantity,5);assert.deepEqual(g.fills.map(f=>[f.price,f.quantity,f.maker,f.botSelection]),[[10000,1,g.agents[1].id,'worst'],[9900,2,g.agents[1].id,'worst'],[9900,2,g.agents[0].id,'worst']]);
 assert.equal(orderBook(g).bestAsk,10);assert.equal(g.orders[0].quantity,100);
 assert.equal(g.agents.reduce((n,a)=>n+a.cash,0),0);assert.equal(g.agents.reduce((n,a)=>n+a.position,0),0);
 const h=fixture5(),a=h.agents.at(-1)!;place(h,0,'sell',100,99);place(h,1,'sell',100,100);
 match(h,a,'buy','market',1,null,3000,'best');match(h,a,'buy','market',1,null,3001,'worst');assert.deepEqual(h.fills.map(f=>f.price),[9900,10000]);
 assert.throws(()=>match(h,a,'buy','market',6,null,3002,'worst'),/1–5/);
});
test('Atlas worst sells take lowest bids first with FIFO and no liquidity creation',()=>{
 const g=fixture5();place(g,1,'buy',100,90);place(g,1,'buy',2,1);place(g,0,'buy',2,1);place(g,1,'buy',1,0);
 match(g,g.agents.at(-1)!,'sell','market',5,null,3000,'worst');assert.deepEqual(g.fills.map(f=>[f.price,f.quantity,f.maker]),[[0,1,g.agents[1].id],[100,2,g.agents[1].id],[100,2,g.agents[0].id]]);assert.equal(orderBook(g).bestBid,90);assert.equal(g.orders[0].quantity,100);
 const h=fixture5();const r=match(h,h.agents.at(-1)!,'sell','market',5,null,3000,'worst');assert.equal(r.filledQuantity,0);assert.equal(r.canceledQuantity,5);assert.equal(h.orders.length,0);assert.equal(h.lastPrice,null);
});
test('ordinary agents cannot request worst-first matching and marketable limits still take the best price',()=>{
 const g=fixture();place(g,1,'sell',10,10);place(g,1,'sell',10,100);
 assert.throws(()=>match(g,g.agents[0],'buy','market',1,null,3000,'worst'),/Only Atlas/);
 place(g,0,'buy',1,100);assert.equal(g.fills[0].price,1000);assert.equal(g.fills[0].botSelection,undefined);
});
test('Atlas records all six reproducible 50/50 selections with capped executions and final trace freezes',()=>{
 function round(){const g=fixture5();place(g,0,'buy',1000,1);place(g,1,'buy',1000,40);place(g,0,'sell',1000,60);place(g,1,'sell',1000,99);advance(g,62000);return g;}
 const g=round(),h=round(),s=publicState(g,62000);assert.equal(s.atlas.executionMode,'best_worst_50_50');assert.equal(s.atlas.ticks.length,6);assert.ok(s.atlas.bestAttempts>0&&s.atlas.worstAttempts>0);assert.equal(s.atlas.bestAttempts+s.atlas.worstAttempts,6);
 assert.deepEqual(g.botTicks!.map(({executions,...tick})=>tick),h.botTicks!.map(({executions,...tick})=>tick));
 for(const t of s.atlas.ticks){assert.ok(t.requestedQuantity>=1&&t.requestedQuantity<=5);assert.ok(t.filledQuantity<=t.requestedQuantity);assert.equal(t.filledQuantity+t.canceledQuantity,t.requestedQuantity);assert.equal(t.executions.reduce((q,f)=>q+f.quantity,0),t.filledQuantity);assert.equal(t.executions[0].price,t.selection==='best'?t.bestAvailablePrice:t.worstAvailablePrice);assert.equal(t.time%10000,2000);}
 assert.equal(s.atlas.bestFilledQuantity+s.atlas.worstFilledQuantity,s.atlas.filledQuantity);assert.equal(Reflect.get(s.rules,'botBestProbability'),.5);assert.equal(Reflect.get(s.rules,'botWorstProbability'),.5);assert.match(observation(g,g.agents[0],62000).rules.bot,/worst-first/);
 const before=JSON.stringify(s.atlas);advance(g,999999);assert.equal(JSON.stringify(publicState(g,999999).atlas),before);
});
test('schema-4 midpoint rounds retain best-only Atlas, their old random sequence, and frozen valuation',()=>{
 const g=fixture();g.schema=4;place(g,0,'buy',1000,1);place(g,1,'buy',1000,40);place(g,0,'sell',1000,60);place(g,1,'sell',1000,99);advance(g,62000);const s=publicState(g,62000);assert.equal(s.scoringMode,'closing_midpoint');assert.equal(s.valuation.price,50);assert.equal(s.atlas.executionMode,'best');assert.equal(s.atlas.bestAttempts,6);assert.equal(s.atlas.worstAttempts,0);assert.equal(Reflect.get(s.rules,'botWorstProbability'),0);assert.ok(g.fills.every(f=>f.price===4000||f.price===6000));assert.deepEqual(g.fills.map(f=>[f.side,f.quantity]),[['sell',1],['buy',2],['sell',1],['sell',1],['buy',5],['buy',3]]);
});

// Schema 7: random limit IOC Atlas around a hidden center C drawn from a committed 256-bit secret, settled at C.
const SECRET='00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff',OTHER='ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100';
function fixture7(secret=SECRET,seed=42){const g=createGame('game_00000000-0000-0000-0000-000000000000','host','owner',[{name:'Alice',provider:'external'},{name:'Bob',provider:'external'}],1000,seed,secret,60_000);startGame(g,2000);return g;}
// Historical schema-6 rounds: an LCG stream seeded by the public seed and a secret 32-bit nonce, no commitment.
function fixture6(nonce=7){const g=createGame('game_00000000-0000-0000-0000-000000000000','host','owner',[{name:'Alice',provider:'external'},{name:'Bob',provider:'external'}],1000,42,undefined,60_000);g.schema=6;g.atlasNonce=nonce;delete g.atlasSecret;delete g.atlasCommitment;startGame(g,2000);return g;}
test('new games use schema 7 with a committed secret and a reproducible Poisson plan inside the center band',()=>{
 const g=fixture7(),h=fixture7(),other=fixture7(OTHER),reseeded=fixture7(SECRET,43);assert.equal(g.schema,7);assert.deepEqual(g.atlasPlan,h.atlasPlan);assert.equal(g.atlasCenter,h.atlasCenter);assert.notDeepEqual(g.atlasPlan,other.atlasPlan);assert.notDeepEqual(g.atlasPlan,reseeded.atlasPlan);
 assert.equal(g.atlasCommitment,atlasCommitment(SECRET));assert.equal(g.atlasCommitment,createHash('sha256').update(Buffer.from(SECRET,'hex')).digest('hex'));assert.equal(g.atlasNonce,undefined);
 const c=g.atlasCenter!,plan=g.atlasPlan!;assert.ok(c>=2000&&c<=8000);assert.ok(plan.length>=10&&plan.length<=60,`arrivals ${plan.length}`);
 for(const [i,p] of plan.entries()){assert.ok(p.time>2000&&p.time<62000);if(i)assert.ok(p.time>=plan[i-1].time);assert.ok(Math.abs(p.limit-c)<=500);assert.ok(Number.isInteger(p.quantity)&&p.quantity>=1&&p.quantity<=5);assert.ok(p.side==='buy'||p.side==='sell');}
 const centers=new Set<number>();for(let n=0;n<20;n++)centers.add(fixture7(n.toString(16).padStart(64,'0')).atlasCenter!);assert.ok(centers.size>10);
 assert.throws(()=>createGame('x','h','',[],1000,42,'not-hex'),/32 random bytes/);assert.throws(()=>createGame('x','h','',[],1000,42,SECRET.toUpperCase()),/32 random bytes/);
 const fresh=createGame('a','h','',[],1000),again=createGame('b','h','',[],1000);assert.match(fresh.atlasSecret!,/^[0-9a-f]{64}$/);assert.notEqual(fresh.atlasSecret,again.atlasSecret);assert.equal(fresh.atlasCommitment,atlasCommitment(fresh.atlasSecret!));
});
test('the revealed secret replays the center and every arrival; the stream matches an independent SHA-256 derivation',()=>{
 const g=fixture7(),replay=replayAtlas(g.seed,g.atlasSecret!,g.startedAt!,g.endsAt!);assert.equal(replay.center,g.atlasCenter);assert.deepEqual(replay.plan,g.atlasPlan);
 const next=atlasStream(SECRET,42),expected:number[]=[];
 for(let counter=0;counter<3;counter++){const m=Buffer.alloc(40);Buffer.from(SECRET,'hex').copy(m);m.writeUInt32BE(42,32);m.writeUInt32BE(counter,36);const d=createHash('sha256').update(m).digest();for(let i=0;i<8;i++)expected.push(d.readUInt32BE(i*4)/4294967296);}
 for(const e of expected)assert.equal(next(),e);
 advance(g,62000);const s=publicState(g,62000);assert.equal(s.atlas.secret,SECRET);assert.equal(s.atlas.commitment,atlasCommitment(SECRET));
 const audited=replayAtlas(s.seed,s.atlas.secret!,s.startedAt!,s.endsAt!),ticks=s.atlas.ticks as any[];
 assert.deepEqual(ticks.map(t=>[t.time,t.side,t.requestedQuantity,t.limitPrice]),audited.plan.map(p=>[p.time,p.side,p.quantity,p.limit/100]));assert.equal(s.atlas.center,audited.center/100);
});
test('historical schema-6 rounds keep their nonce-seeded plan and legacy rules text',()=>{
 const g=fixture6(),h=fixture6(),other=fixture6(8);assert.equal(g.schema,6);assert.deepEqual(g.atlasPlan,h.atlasPlan);assert.notDeepEqual(g.atlasPlan,other.atlasPlan);assert.ok(g.atlasCenter!>=2000&&g.atlasCenter!<=8000);
 assert.match(String(Reflect.get(observation(g,g.agents[0],2001).rules,'botRandomness')),/Historical schema-6/);
 advance(g,62000);const s=publicState(g,62000);assert.equal(s.atlas.nonce,7);assert.equal(s.atlas.commitment,null);assert.equal(s.atlas.secret,null);assert.equal(s.settlementPrice,g.atlasCenter!/100);
});
test('stub quotes at the price extremes never trade with Atlas',()=>{
 const g=fixture7();place(g,0,'buy',1000,.01);place(g,0,'sell',1000,99.99);place(g,1,'buy',1000,0);place(g,1,'sell',1000,100);advance(g,62000);
 assert.equal(g.fills.length,0);assert.equal(g.botAttempts,g.atlasPlan!.length);assert.ok(g.botTicks!.every(t=>t.filledQuantity===0&&t.canceledQuantity===t.requestedQuantity));assert.ok(g.agents.every(a=>a.position===0&&a.cash===0));
});
test('Atlas limits fill at the best resting price only, then cancel the remainder',()=>{
 const g=fixture7(),atlas=g.agents.at(-1)!,c=g.atlasCenter!/100;g.atlasPlan=[];
 place(g,1,'sell',2,c+1);place(g,0,'sell',2,c+1);place(g,1,'sell',10,c+6);
 const r=match(g,atlas,'buy','market',5,g.atlasCenter!+500,3000);
 assert.equal(r.filledQuantity,4);assert.equal(r.canceledQuantity,1);assert.deepEqual(g.fills.map(f=>[f.price,f.quantity,f.maker,f.botSelection]),[[g.atlasCenter!+100,2,g.agents[1].id,undefined],[g.atlasCenter!+100,2,g.agents[0].id,undefined]]);
 assert.equal(orderBook(g).bestAsk,c+6);assert.ok(g.orders.every(o=>o.agentId!=='$atlas'));
 place(g,1,'buy',3,c-2);const s=match(g,atlas,'sell','market',5,g.atlasCenter!-100,3001);assert.equal(s.filledQuantity,0);assert.equal(s.canceledQuantity,5);
 assert.throws(()=>match(g,atlas,'buy','market',1,null,3002,'worst'),/Only Atlas/);
});
test('Atlas arrivals execute against agent quotes and the round settles at the hidden center',()=>{
 const g=fixture7(),c=g.atlasCenter!/100;place(g,0,'buy',200,c-1);place(g,0,'sell',200,c+1);place(g,1,'buy',1,.01);place(g,1,'sell',1,99.99);
 const live=publicState(g,2001);assert.equal(live.scoringMode,'hidden_center');assert.equal(live.valuation.source,'midpoint');assert.equal(live.valuation.price,c);
 advance(g,62000);const s=publicState(g,62000);
 assert.ok(g.fills.length>0);assert.ok(g.fills.every(f=>f.maker===g.agents[0].id&&f.taker==='$atlas'));
 for(const t of g.botTicks!){assert.equal(t.filledQuantity,t.side==='buy'?(t.limitPrice!>=c+1?t.requestedQuantity:0):(t.limitPrice!<=c-1?t.requestedQuantity:0));}
 assert.equal(s.valuation.source,'atlas_center');assert.equal(s.settlementPrice,c);assert.equal(s.atlas.center,c);assert.equal(s.atlas.nonce,null);assert.equal(s.atlas.secret,SECRET);
 const alice=g.agents[0];assert.ok(Math.abs(s.agents[0].pnl-(alice.cash+alice.position*g.atlasCenter!)/100)<1e-9);assert.ok(s.agents[0].pnl>0);assert.equal(s.agents[1].pnl,0);
 assert.ok(Math.abs([...s.agents,s.atlas].reduce((v,a)=>v+a.pnl,0))<1e-8);
 const before=JSON.stringify(s);advance(g,999999);assert.equal(JSON.stringify(publicState(g,62000)),before);
});
test('final quotes cannot move the schema-7 settlement reference',()=>{
 const g=fixture7(),c=g.atlasCenter!/100;place(g,1,'sell',5,c+2);place(g,0,'buy',5);place(g,0,'buy',1000,99.98);place(g,0,'sell',1000,99.99);
 assert.ok(publicState(g,2001).valuation.price!>99);advance(g,62000);assert.equal(publicState(g,62000).settlementPrice,c);
});
test('the center, limits, secret and unfilled arrivals stay hidden until the close; the commitment is public throughout',()=>{
 const g=fixture7(),c=g.atlasCenter!/100;assert.equal(publicState(g,1500).atlas.commitment,atlasCommitment(SECRET));
 place(g,0,'buy',1000,c-4);place(g,0,'sell',1000,c+4);advance(g,40000);
 assert.ok(g.botTicks!.some(t=>t.filledQuantity===0)&&g.botTicks!.some(t=>t.filledQuantity>0),'fixture needs both kinds of arrival');
 const views=[publicState(g,40000),observation(g,g.agents[0],40000)],text=JSON.stringify(views);
 for(const key of ['atlasCenter','atlasPlan','atlasNonce','atlasSecret','limitPrice','requestedQuantity','canceledQuantity',SECRET])assert.ok(!text.includes(key),key);
 for(const v of views){assert.equal(v.atlas.center,null);assert.equal(v.atlas.secret,null);assert.equal(v.atlas.commitment,atlasCommitment(SECRET));assert.equal(v.atlas.attempts,null);assert.equal(v.atlas.ticks.length,g.botTicks!.filter(t=>t.filledQuantity>0).length);}
 const pub=publicState(g,40000).atlas;assert.equal(pub.submittedQuantity,null);assert.equal(pub.maxAttempts,null);assert.ok(g.events.every(e=>e.agentId!=='$atlas'||e.type==='fill'));
 advance(g,62000);const s=publicState(g,62000);assert.equal(s.atlas.secret,SECRET);assert.equal(s.atlas.ticks.length,g.atlasPlan!.length);assert.equal(s.atlas.attempts,g.atlasPlan!.length);assert.equal(s.atlas.maxAttempts,g.atlasPlan!.length);assert.ok(s.atlas.ticks.every(t=>'limitPrice' in t&&typeof t.limitPrice==='number'));
});
test('schema-7 rules describe the limit IOC bot and the commitment; schema-5 rounds keep best/worst rules',()=>{
 const g=fixture7(),r=observation(g,g.agents[0],2001).rules;assert.equal(r.botExecutionMode,'limit_ioc');assert.equal(r.scoringMode,'hidden_center');assert.equal(r.botMeanIntervalSeconds,2);assert.deepEqual(r.botCenterRange,[20,80]);assert.equal(r.botLimitBand,5);assert.match(r.bot,/immediate-or-cancel/);assert.match(r.bot,/committed by SHA-256/);assert.match(String(Reflect.get(r,'botRandomness')),/SHA-256\(secret \|\| seed/);
 const h=fixture5();assert.equal(observation(h,h.agents[0],2001).rules.botExecutionMode,'best_worst_50_50');
});

test('the system prompt carries the per-game rules once and tells the model snapshots omit them',async()=>{
 const g=createGame('x','h','',[{name:'A',provider:'external'}],1000,42,undefined,480000);startGame(g,2000);
 const prompt=systemPrompt(observation(g,g.agents[0],2001).rules);assert.match(prompt,/"durationSeconds":480/);assert.match(prompt,/not repeated in snapshots/);assert.match(SYSTEM_PROMPT,/"durationSeconds":180/);
 let body:any;await complete({provider:'sail',model:'m',apiKey:'k'},[{role:'user',content:'{}'}],1000,async(_u,init)=>{body=JSON.parse(init!.body as string);return Response.json({choices:[{message:{content:'ok'}}]});},observation(g,g.agents[0],2001).rules);
 assert.match(body.messages[0].content,/"durationSeconds":480/);
});
test('model agents are free-running by default, rule strategies keep 2 s, and intervals are bounded',()=>{
 const g=createGame('g','h','',[{name:'Model',provider:'sail',model:'m'},{name:'Rules',provider:'baseline',strategy:'maker'},{name:'Slow',provider:'sail',model:'m',intervalMs:10000}],1000);
 assert.equal(g.agents[0].intervalMs,0);assert.equal(g.agents[1].intervalMs,2000);assert.equal(g.agents[2].intervalMs,10000);assert.equal(MIN_DECISION_GAP_MS,250);
 for(const bad of [-1,10001,1.5])assert.throws(()=>createGame('x','h','',[{name:'A',provider:'sail',model:'m',intervalMs:bad}],1000),/Decision interval/);
 assert.equal(presetCallLimit(180000),180);assert.equal(presetCallLimit(60000),60);
});
test('rounds default to 180 seconds, accept 30–600 s per game, scale call budgets, and keep legacy 60 s games',()=>{
 const g=createGame('game_00000000-0000-0000-0000-000000000000','host','owner',[{name:'A',provider:'external'},{name:'B',provider:'external'}],1000);startGame(g,2000);
 assert.equal(g.durationMs,180000);assert.equal(g.endsAt,182000);assert.equal(publicState(g,2001).durationMs,180000);assert.equal(publicState(g,2001).remainingMs,179999);
 const o=observation(g,g.agents[0],2001);assert.equal(o.rules.durationSeconds,180);assert.equal(o.durationMs,180000);assert.equal(o.remainingMs,179999);
 assert.equal(callLimit(g),360);assert.equal(atlasArrivalCap(180000),320);assert.equal(atlasArrivalCap(60000),140);
 assert.match(g.events.at(-1)!.message,/180 seconds/);
 place(g,0,'buy',1000,.01);advance(g,181999);assert.equal(g.status,'running');advance(g,182000);assert.equal(g.status,'finished');assert.equal(g.finishedAt,182000);
 assert.ok(g.atlasPlan!.every(p=>p.time<182000));assert.ok(g.atlasPlan!.length>50&&g.atlasPlan!.length<180,`arrivals ${g.atlasPlan!.length}`);assert.equal(g.botAttempts,g.atlasPlan!.length);
 assert.deepEqual(replayAtlas(g.seed,g.atlasSecret!,g.startedAt!,g.endsAt!).plan,g.atlasPlan);
 const short=createGame('x','h','',[{name:'A',provider:'external'}],1000,42,undefined,30000);startGame(short,2000);assert.equal(short.endsAt,32000);assert.equal(observation(short,short.agents[0],2001).rules.durationSeconds,30);
 assert.equal(RULES.durationSeconds,180);assert.deepEqual(RULES.durationRange,[30,600]);
 for(const bad of [29000,601000,90500,1.5,NaN,'180' as unknown as number])assert.throws(()=>createGame('x','h','',[],1000,42,undefined,bad),/Round length/);
 const legacy=createGame('y','h','',[],1000) as Record<string,unknown>;delete legacy.durationMs;assert.equal(durationOf(legacy as {durationMs?:number}),60000);assert.equal(callLimit(legacy as {durationMs?:number}),120);
});

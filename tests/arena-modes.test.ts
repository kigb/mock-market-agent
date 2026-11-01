import test from 'node:test';
import assert from 'node:assert/strict';
import {createGame,startGame,advance,intent,match,publicState,observation,orderBook,replayRelativeAtlas,atlasCommitment,riskCapacity,rulesFor,modeRules,BOT_MODES,DEFAULT_BOT_MODE,type Game,type Intent} from '../lib/arena/engine.ts';
import {baseline} from '../lib/arena/providers.ts';
import {systemPrompt,MCP_TOOLS} from '../lib/arena/protocol.ts';
const SECRET='01'.repeat(32);
function fixture(){const g=createGame('modes','host','',[{name:'A',provider:'external'},{name:'B',provider:'external'},{name:'C',provider:'external'}],1000,42,SECRET);startGame(g,2000);g.atlasPlan=[];return g;}
function place(g:Game,i:number,side:'buy'|'sell',q:number,p:number,now=2001,extras:Partial<Intent>={}){return intent(g,g.agents[i],{action:'place_order',side,quantity:q,price:p,...extras},now) as any;}
function fill(g:Game,price:number,q:number,time:number){place(g,0,'sell',q,price,time);place(g,1,'buy',q,price,time);}
test('public default selects market-relative rules; hidden-center mode and historical schema-7 remain explicit and unchanged',()=>{
 const g=fixture();assert.equal(DEFAULT_BOT_MODE,'market_relative');assert.equal(BOT_MODES.length,2);assert.equal(g.schema,8);assert.equal(g.durationMs,60000);assert.equal(g.atlasCenter,undefined);assert.equal(g.atlasCommitment,atlasCommitment(SECRET));
 const r=rulesFor(g);assert.equal(Reflect.get(r,'botMode'),'market_relative');assert.equal(r.scoringMode,'market_vwap');assert.equal(r.botCenterRange,null);assert.deepEqual(r.quantityRange,[1,20]);assert.equal(publicState(g,2001).botIntervalMs,1000);
 const old=createGame('old','host','',[],1000,42,SECRET,undefined,'hidden_center');assert.equal(old.schema,7);assert.equal(old.durationMs,180000);assert.equal(rulesFor(old).scoringMode,'hidden_center');assert.equal(modeRules().botMode,'market_relative');assert.throws(()=>modeRules('invalid'));assert.throws(()=>createGame('x','h','',[],0,42,SECRET,60000,'nope' as any));
});
test('independent relative streams reproduce arrivals without a center or action-dependent randomness',()=>{
 const a=replayRelativeAtlas(42,SECRET,2000,62000),b=replayRelativeAtlas(42,SECRET,2000,62000);assert.deepEqual(a,b);assert.notDeepEqual(a,replayRelativeAtlas(43,SECRET,2000,62000));assert.ok(a.plan.length>25&&a.plan.length<100);
 assert.ok(a.plan.every(p=>p.time>2000&&p.time<62000&&p.quantity>=1&&p.quantity<=5&&p.distance!>=1&&p.distance!<=50));
 const g=fixture();g.atlasPlan=a.plan;advance(g,62000);assert.equal(g.botAttempts,a.plan.length);assert.ok(g.botTicks!.every(t=>t.skipReason==='one_sided'));assert.equal(publicState(g,62000).atlas.secret,SECRET);
});
test('mid-relative IOC uses one fixed limit across the sweep, obeys total quantity and FIFO, and never rests Atlas orders',()=>{
 const g=fixture();place(g,0,'buy',5,60);place(g,1,'sell',2,60.02);place(g,2,'sell',2,60.02);place(g,1,'sell',3,60.04);
 g.atlasPlan=[{time:3000,side:'buy',quantity:5,distance:2,limit:0}];advance(g,3000);
 const t=g.botTicks![0];assert.equal(t.referenceMid,60.01);assert.equal(t.limitPrice,60.03);assert.equal(t.filledQuantity,4);assert.equal(t.canceledQuantity,1);assert.deepEqual(t.executions.map(e=>[e.price,e.quantity,e.maker]),[[60.02,2,g.agents[1].id],[60.02,2,g.agents[2].id]]);assert.ok(g.orders.every(o=>o.agentId!=='$atlas'));assert.equal(orderBook(g).bestAsk,60.04);
});
test('skip one-sided and >1.00 spreads without redrawing; a later valid event uses its originally sampled side',()=>{
 const g=fixture();g.atlasPlan=[{time:3000,side:'buy',quantity:5,distance:50,limit:0},{time:4000,side:'sell',quantity:2,distance:50,limit:0},{time:5000,side:'buy',quantity:3,distance:50,limit:0}];
 place(g,0,'buy',5,.01);advance(g,3000);assert.equal(g.botTicks![0].skipReason,'one_sided');place(g,1,'sell',5,99.99,3001);advance(g,4000);assert.equal(g.botTicks![1].skipReason,'wide_spread');
 intent(g,g.agents[0],{action:'cancel_all'},4001);intent(g,g.agents[1],{action:'cancel_all'},4001);place(g,0,'buy',5,60,4002);place(g,1,'sell',5,60.02,4002);advance(g,5000);assert.equal(g.botAttempts,3);assert.equal(g.botTicks![2].side,'buy');assert.equal(g.botTicks![2].filledQuantity,3);
});
test('half-tick midpoint limits round toward price protection and clamp correctly near both price boundaries',()=>{
 for(const [bid,ask,side,expected] of [[59.99,60,'buy',60],[59.99,60,'sell',59.99],[0,.01,'sell',0],[99.99,100,'buy',100]] as const){const g=fixture();place(g,0,'buy',5,bid);place(g,1,'sell',5,ask);g.atlasPlan=[{time:3000,side,quantity:1,distance:1,limit:0}];advance(g,3000);assert.equal(g.botTicks![0].limitPrice,expected);}
});
test('shifting a tight market from 50 to 60 preserves fills and marked P&L in market-relative mode',()=>{
 function round(shift:number){const g=fixture();place(g,0,'buy',20,49.99+shift);place(g,1,'sell',20,50.01+shift);g.atlasPlan=replayRelativeAtlas(42,SECRET,2000,62000).plan;advance(g,62000);return g;}
 const a=round(0),b=round(10);assert.deepEqual(a.fills.map(f=>[f.quantity,f.side]),b.fills.map(f=>[f.quantity,f.side]));assert.ok(a.fills.length>0);assert.equal(a.fills.length,b.fills.length);
 assert.ok(Math.abs(publicState(a,62000).settlementPrice!+10-publicState(b,62000).settlementPrice!)<1e-8);publicState(a,62000).agents.forEach((v,i)=>assert.ok(Math.abs(v.pnl-publicState(b,62000).agents[i].pnl)<1e-8));
});
test('reserve each pending side independently, enforce full IOC capacity, and release reservations on cancellation',()=>{
 const g=fixture(),a=g.agents[0];place(g,0,'buy',18,40);place(g,0,'sell',20,60);assert.equal(riskCapacity(g,a).buyCapacity,2);assert.equal(riskCapacity(g,a).sellCapacity,0);assert.throws(()=>place(g,0,'buy',3,40),/POSITION_LIMIT/);assert.throws(()=>place(g,0,'sell',1,60),/POSITION_LIMIT/);
 intent(g,a,{action:'cancel_all'},2002);assert.equal(riskCapacity(g,a).buyCapacity,20);place(g,1,'sell',18,50,2003);place(g,0,'buy',18,50,2003);assert.equal(a.position,18);place(g,0,'buy',2,49,2004);assert.throws(()=>place(g,0,'buy',1,50,2004,{timeInForce:'IOC'}),/POSITION_LIMIT/);assert.throws(()=>place(g,0,'buy',21,50,2004),/Quantity/);
 place(g,0,'sell',18,50,2005,{timeInForce:'IOC'});assert.ok(a.position<=20);
});
test('protected market orders and limit IOC never execute past their limit; post-only rejection leaves the book intact',()=>{
 const g=fixture();place(g,1,'sell',2,60);place(g,2,'sell',3,60.03);assert.throws(()=>intent(g,g.agents[0],{action:'place_order',side:'buy',type:'market',quantity:4},2002),/MISSING_PRICE_PROTECTION/);
 const before=JSON.stringify(g.orders);assert.throws(()=>place(g,0,'buy',4,60.02,2002,{postOnly:true}),/POST_ONLY_WOULD_CROSS/);assert.equal(JSON.stringify(g.orders),before);
 const r=place(g,0,'buy',4,60.02,2003,{timeInForce:'IOC'});assert.equal(r.filledQuantity,2);assert.equal(r.canceledQuantity,2);assert.equal(r.remainingQuantity,0);assert.equal(g.agents[0].position,2);assert.equal(orderBook(g).bestAsk,60.03);
});
test('replacement validates atomically, replaces its own capacity, and always loses FIFO priority',()=>{
 const g=fixture();const first=place(g,0,'buy',20,40),second=place(g,1,'buy',5,40);
 assert.throws(()=>intent(g,g.agents[0],{action:'replace_order',orderId:first.orderId,side:'buy',quantity:21,price:40},2002),/Quantity/);assert.ok(g.orders.some(o=>o.id===first.orderId));
 const replaced=intent(g,g.agents[0],{action:'replace_order',orderId:first.orderId,side:'buy',quantity:20,price:40},2003) as any;assert.equal(replaced.replacedOrderId,first.orderId);assert.equal(riskCapacity(g,g.agents[0]).reservedBuy,20);
 const trade=place(g,2,'sell',3,40,2004);assert.equal(trade.filledQuantity,3);assert.equal(g.fills[0].maker,g.agents[1].id);assert.equal(g.orders.find(o=>o.id===second.orderId)?.quantity,2);
});
test('idempotent retries do not trade twice; changed payloads conflict even after close',()=>{
 const g=fixture(),a=g.agents[0],input:Intent={action:'place_order',side:'buy',quantity:2,price:40};
 const r=intent(g,a,input,2001,'same');assert.deepEqual(intent(g,a,input,2002,'same'),r);assert.throws(()=>intent(g,a,{...input,price:41},2002,'same'),/IDEMPOTENCY_CONFLICT/);advance(g,62000);assert.deepEqual(intent(g,a,input,70000,'same'),r);assert.throws(()=>place(g,0,'buy',1,40,70000),/ended/);
});
test('settle at final-window quantity-weighted real trades, preserve fractional ticks and frozen cash settlement archives',()=>{
 const g=fixture();fill(g,40,1,3000);fill(g,60,1,52000);fill(g,60.01,2,53000);fill(g,60.02,7,54000);place(g,0,'buy',1,1,61000);place(g,2,'sell',1,99,61000);
 advance(g,62000);const s=publicState(g,62000),expected=(60+60.01*2+60.02*7)/10;assert.ok(Math.abs(s.settlementPrice!-expected)<1e-10);assert.equal(s.valuation.source,'window_vwap');assert.equal(s.settlement?.quality,'normal');assert.equal(s.settlement?.windowEvents,3);assert.equal(s.settlement?.windowVolume,10);assert.notEqual(s.settlementPrice,50);assert.equal(s.settlement?.closingMidpoint,50);
 assert.ok(Math.abs([...s.agents,s.atlas].reduce((n,a)=>n+a.pnl,0))<1e-8);assert.ok(s.settlement!.accounts.every(a=>a.positionAfter===0));assert.ok(Math.abs(s.settlement!.accounts.reduce((n,a)=>n+a.cashAfter,0))<1e-8);
 const frozen=JSON.stringify(s.settlement);g.lastPrice=9900;advance(g,99000);assert.equal(JSON.stringify(publicState(g,99000).settlement),frozen);
});
test('empty final window falls back to full-round VWAP; no-trade games remain unpriced with zero scores',()=>{
 const g=fixture();fill(g,20,1,3000);fill(g,40,3,4000);advance(g,62000);const s=publicState(g,62000);assert.equal(s.settlementPrice,35);assert.equal(s.valuation.source,'full_round_vwap');assert.equal(s.settlement?.quality,'low');
 const empty=fixture();advance(empty,62000);const e=publicState(empty,62000);assert.equal(e.settlementPrice,null);assert.equal(e.settlement?.quality,'no_trades');assert.ok(e.agents.every(a=>a.pnl===0));
});
test('thin-window quality counts taker orders, not partial fills, and never changes the settlement formula',()=>{
 const g=fixture();place(g,0,'sell',5,50,52000);place(g,2,'sell',5,50,52000);place(g,1,'buy',10,50,53000);advance(g,62000);const s=publicState(g,62000);assert.equal(s.settlement?.windowVolume,10);assert.equal(s.settlement?.windowEvents,1);assert.equal(s.settlement?.quality,'low');assert.equal(s.settlementPrice,50);
});
test('Atlas events at or after the deadline do not trade; every earlier scheduled event is handled once',()=>{
 const g=fixture();place(g,0,'buy',10,50);place(g,1,'sell',10,50.02);g.atlasPlan=[{time:61999,side:'buy',quantity:2,distance:50,limit:0},{time:62000,side:'sell',quantity:2,distance:50,limit:0} ];advance(g,70000);assert.equal(g.botAttempts,1);assert.equal(g.fills.length,1);const vol=g.volume;advance(g,90000);assert.equal(g.volume,vol);
});
test('baselines obey mode risk constraints at full inventory and emit protective prices for taking',()=>{
 for(const strategy of ['maker','momentum','mean_reversion'] as const){const g=fixture(),a=g.agents[0];a.strategy=strategy;place(g,1,'sell',20,50);place(g,0,'buy',20,50);place(g,2,'sell',5,50);for(const input of baseline(g,a))intent(g,a,input,3000);assert.ok(a.position<=20);const cap=riskCapacity(g,a);assert.ok(cap.buyCapacity!>=0&&cap.sellCapacity!>=0);}
});
test('2,000 random protected orders, cancels and fills preserve cash, inventory and reserved risk bounds',()=>{
 const g=fixture();let state=7;const rand=()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state/2**32;};
 for(let i=0;i<2000;i++){const a=g.agents[i%3],now=2001+Math.floor(i/30)*300;try{intent(g,a,{action:'cancel_all'},now);intent(g,a,{action:'place_order',side:rand()<.5?'buy':'sell',price:Math.floor(rand()*10001)/100,quantity:1+Math.floor(rand()*20),timeInForce:rand()<.2?'IOC':'GTC'},now);}catch(e){assert.match((e as Error).message,/POSITION_LIMIT|20 trading actions/);}
  assert.equal(g.agents.reduce((n,a)=>n+a.position,0),0);assert.equal(g.agents.reduce((n,a)=>n+a.cash,0),0);for(const a of g.agents.filter(a=>a.id!=='$atlas')){const cap=riskCapacity(g,a);assert.ok(cap.buyCapacity!>=0&&cap.sellCapacity!>=0);}}
});
test('mode-specific prompts, discovery, observations and traces expose the right rules without secrets',()=>{
 const g=fixture(),r=rulesFor(g),p=systemPrompt(r);assert.ok(p.includes('market_relative'));assert.ok(p.includes('maxAbsPosition'));assert.ok(!p.includes('infer C from where Atlas trades'));
 const text=JSON.stringify(observation(g,g.agents[0],2001));assert.ok(!text.includes(SECRET)&&!text.includes(g.agents[0].token));assert.equal(observation(g,g.agents[0],2001).riskCapacity.buyCapacity,20);assert.equal(publicState(g,2001).atlas.center,null);assert.equal(publicState(g,2001).atlas.secret,null);assert.equal(publicState(g,2001).atlas.maxAttempts,null);assert.ok(MCP_TOOLS.some(t=>t.name==='replace_order'));
});

test('full-round fallback remains exact after the retained fill history rolls over',()=>{
 const g=fixture();g.durationMs=180000;g.endsAt=182000;
 for(let i=0;i<1300;i++){const price=i<100?20:60,time=3000+i*80;place(g,i%2,'sell',1,price,time);place(g,1-i%2,'buy',1,price,time);}
 assert.equal(g.fills.length,1200);advance(g,182000);const s=publicState(g,182000);assert.ok(Math.abs(s.settlementPrice!-(100*20+1200*60)/1300)<1e-10);assert.equal(s.valuation.source,'full_round_vwap');
});

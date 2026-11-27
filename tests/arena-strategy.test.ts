import test from 'node:test';
import assert from 'node:assert/strict';
import {createGame,startGame,addAgent,intent,advance,observation,publicState,strategyEnv,strategyView,MAX_AGENTS,STRATEGY_INTERVAL_MS,ArenaError,type Game} from '../lib/arena/engine.ts';
import {compileProgram,evaluateFormula,evaluateProgram,StrategyError,STRATEGY_VARIABLES} from '../lib/arena/strategy.ts';
import {MODEL_TOOLS,STRATEGY_PROMPT,modelTools,systemPrompt} from '../lib/arena/protocol.ts';
import {complete} from '../lib/arena/providers.ts';
import {converse,headerSnapshot,normalizeCompletion,READ_TOOLS,type Completion} from '../lib/arena/conversation.ts';
import {roundLog} from '../lib/arena/roundlog.ts';
import type {DecisionEntry} from '../lib/arena/store.ts';
const SECRET='00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
// Coder has the plan and strategy tools; Plain is the same kind of agent without them. Started at 2000, ends at 62000,
// so strategy ticks land at 2500, 3000, … 61500.
function game(){const g=createGame('game_00000000-0000-0000-0000-000000000000','host','',[{name:'Coder',provider:'fireworks',model:'m',strategyTools:true},{name:'Plain',provider:'fireworks',model:'m'},{name:'Outsider',provider:'external'}],1000,42,SECRET,60_000,'hidden_center');startGame(g,2000);return g;}
const val=(source:string,env:Record<string,number|null>={})=>evaluateFormula(source,env);
const records=(g:Game)=>g.autoOut??[];
// Quotes this far from the hidden center can never be reached by Atlas (its limits stay within C ± 5).
const far=8,px=(x:number)=>Math.round(x*100)/100;
// The store always advances the clock to the request time before applying an action; tests that cross a tick do the same.
const act=(g:Game,a:Game['agents'][number],input:any,now:number)=>{advance(g,now);return intent(g,a,input,now) as any;};

test('formulas: precedence, null propagation, functions and clear errors',()=>{
 assert.equal(val('1+2*3'),7);assert.equal(val('(1+2)*3'),9);assert.equal(val('-2*-3'),6);assert.equal(val('10/4'),2.5);assert.equal(val('1+1==2'),1);assert.equal(val('0?1:0?2:3'),3);
 assert.equal(val('true&&false'),0);assert.equal(val('1>2||3>2'),1);assert.equal(val('!0'),1);assert.equal(val('min(3,1,2)+max(4,9)'),10);assert.equal(val('clamp(15,0,10)'),10);assert.equal(val('abs(-2)+floor(2.9)+ceil(2.1)+sign(-7)'),6);
 assert.ok(Math.abs(val('round(53.237,0.05)')!-53.25)<1e-9);assert.equal(val('round(2.5)'),3);
 // A missing value is null: arithmetic keeps it, comparisons are false, or() falls back.
 const env={x:null,y:4};
 assert.equal(val('x+1',env),null);assert.equal(val('x<5',env),0);assert.equal(val('x==x',env),0);assert.equal(val('!x',env),1);assert.equal(val('or(x,y,9)',env),4);assert.equal(val('isnull(x)+isnull(y)',env),1);assert.equal(val('x>1?10:20',env),20);
 assert.equal(val('1/0'),null);assert.equal(val('sqrt(-1)'),null);assert.equal(val('null'),null);
 for(const [source,message] of [['foo+1',/unknown name "foo"/],['min()',/min\(\) takes/],['1+',/incomplete|at the end/],['1 $ 2',/unexpected "\$"/],['eval(1)',/unknown function "eval"/],['"x"',/unexpected "\""/],['(1+2',/expected "\)"/],['1 2',/unexpected "2"/]] as const)assert.throws(()=>val(source),message);
});

test('programs: vars are ordered, names cannot shadow built-ins, and limits are enforced',()=>{
 const program=compileProgram({note:' probe ',vars:[{name:'fair',value:'or(mid,lastPrice,50)'},{name:'skew',value:'fair-0.05*position'}],orders:[{side:'buy',price:'skew-1',quantity:5},{side:'sell',price:'skew+1',quantity:'5',when:'remainingMs>5000'}],maxPosition:20,stopWhen:'pnl<-200'},100);
 assert.deepEqual(program.vars.map(v=>v[0]),['fair','skew']);assert.equal(program.orders[0].quantity,'5','numbers are accepted as formulas');assert.equal(program.note,'probe');
 const now=evaluateProgram(program,{...Object.fromEntries(STRATEGY_VARIABLES.map(k=>[k,null])),lastPrice:60,position:10,remainingMs:4000,pnl:0});
 assert.deepEqual(now.vars,{fair:60,skew:59.5});assert.equal(now.stop,false);
 assert.deepEqual(now.orders,[{side:'buy',active:true,price:58.5,quantity:5},{side:'sell',active:false,price:60.5,quantity:5}]);
 const blank=evaluateProgram(compileProgram({orders:[{side:'buy',price:'bestBid+0.01',quantity:'3'},{side:'sell',price:'150',quantity:'3'},{side:'sell',price:'60',quantity:'0.5'}],maxPosition:5},100),Object.fromEntries(STRATEGY_VARIABLES.map(k=>[k,null])));
 assert.deepEqual(blank.orders.map(o=>[o.active,o.problem]),[[false,'price has no value'],[false,'price is outside 0–100'],[false,'quantity is below 1']]);
 assert.deepEqual(compileProgram({vars:{a:'1',b:'a+1'},orders:[{side:'buy',price:'b',quantity:'1'}],maxPosition:1},100).vars,[['a','1'],['b','a+1']],'an object of vars keeps its order');
 const bad=(input:any,message:RegExp)=>assert.throws(()=>compileProgram(input,100),(e:any)=>e instanceof StrategyError&&message.test(e.message));
 const order={side:'buy',price:'50',quantity:'1'};
 bad({vars:[{name:'a',value:'b+1'},{name:'b',value:'1'}],orders:[order],maxPosition:1},/vars\[0\] \(a\).*unknown name "b"/);
 bad({vars:[{name:'mid',value:'1'}],orders:[order],maxPosition:1},/already defined/);bad({vars:[{name:'min',value:'1'}],orders:[order],maxPosition:1},/already defined/);
 bad({orders:[],maxPosition:1},/1–6 order slots/);bad({orders:Array(7).fill(order),maxPosition:1},/1–6 order slots/);bad({orders:[{...order,side:'hold'}],maxPosition:1},/side must be buy or sell/);
 bad({orders:[order],maxPosition:0},/maxPosition/);bad({orders:[order],maxPosition:101},/maxPosition/);bad({orders:[{...order,price:'x'.repeat(241)}],maxPosition:1},/longer than 240/);
 bad({orders:[{...order,price:'midd+1'}],maxPosition:1},/orders\[0\]\.price.*unknown name "midd".*Known names: bestBid/);
});

test('only flagged hosted agents get the tools, and other games keep their exact state shape',()=>{
 const g=game(),[coder,plain,outsider]=g.agents,program={orders:[{side:'buy',price:'40',quantity:'1'}],maxPosition:5};
 for(const a of [plain,outsider])for(const action of ['set_plan','set_strategy','clear_strategy'] as const)assert.throws(()=>intent(g,a,{action,plan:'x',...program} as any,2100),(e:any)=>e instanceof ArenaError&&e.status===403);
 assert.throws(()=>strategyView(g,plain,2100),(e:any)=>e.status===403);
 assert.equal((intent(g,coder,{action:'set_strategy',...program} as any,2100) as any).version,1);
 for(const provider of ['baseline','external'] as const)assert.throws(()=>createGame('g','h','',[{name:'A',provider,strategy:'maker',strategyTools:true}],1000,42,SECRET,60_000,'hidden_center'),/hosted model agents only/);
 // Without a flagged agent there is no strategy clock and no new field anywhere in the state.
 const h=createGame('game_00000000-0000-0000-0000-000000000001','host','',[{name:'A',provider:'external'},{name:'B',provider:'fireworks',model:'m'}],1000,42,SECRET,60_000,'hidden_center');startGame(h,2000);advance(h,62000);
 assert.equal(h.autoAt,undefined);assert.equal(h.autoOut,undefined);assert.ok(!/auto|strategyTools|plan/.test(JSON.stringify(h)));assert.ok(!('program' in publicState(h,62000).agents[0]));
});

test('the exchange evaluates a strategy on its 500 ms clock: place, hold, move, cancel',()=>{
 const g=game(),[coder,plain]=g.agents,c=g.atlasCenter!/100;
 intent(g,plain,{action:'place_order',side:'buy',type:'limit',quantity:5,price:c-far-1},2100);
 const installed:any=intent(g,coder,{action:'set_strategy',note:'penny the best bid',vars:[{name:'edge',value:'0.01'}],orders:[{side:'buy',price:'bestBid+edge',quantity:'5'},{side:'sell',price:String(px(c+far)),quantity:'5',when:'elapsedMs<20000'}],maxPosition:20} as any,2100);
 assert.equal(installed.status,'running');assert.equal(installed.version,1);assert.equal(installed.nextEvaluationInMs,400);
 assert.deepEqual(installed.rightNow.orders,[{side:'buy',active:true,price:Math.round((c-far-0.99)*100)/100,quantity:5},{side:'sell',active:true,price:px(c+far),quantity:5}],'the result previews every formula');
 // Nothing happens until the next tick, so a strategy reacts within half a second, not instantly.
 advance(g,2499);assert.equal(g.orders.filter(o=>o.agentId===coder.id).length,0);assert.equal(records(g).length,0);
 advance(g,2500);const mine=()=>g.orders.filter(o=>o.agentId===coder.id);
 assert.deepEqual(mine().map(o=>[o.side,o.price,o.quantity,o.auto]),[['buy',Math.round((c-far-0.99)*100),5,1],['sell',Math.round((c+far)*100),5,1]]);
 assert.deepEqual(records(g).map(r=>[r.agentId,r.time,r.version,r.actions.map(a=>a.action)]),[[coder.id,2500,1,['place','place']]]);
 // bestBid excludes the agent's own orders, so pennying the book does not chase itself tick after tick.
 const ids=mine().map(o=>o.id);advance(g,10000);assert.deepEqual(mine().map(o=>o.id),ids);assert.equal(records(g).length,1);assert.equal(g.autoAt,10000);
 // The other agent improves its bid: the next tick moves the quote with an atomic replace.
 intent(g,plain,{action:'place_order',side:'buy',type:'limit',quantity:5,price:c-far-0.5},10100);advance(g,10500);
 assert.equal(mine().find(o=>o.side==='buy')!.price,Math.round((c-far-0.49)*100));assert.ok(!g.orders.some(o=>o.id===ids[0]));assert.deepEqual(records(g).at(-1)!.actions.map(a=>[a.action,a.side,a.price]),[['replace','buy',Math.round((c-far-0.49)*100)/100]]);
 // A false `when` cancels that slot's order and leaves the other one alone.
 advance(g,22000);assert.deepEqual(mine().map(o=>o.side),['buy']);assert.deepEqual(records(g).at(-1)!.actions.map(a=>[a.action,a.side,a.reason]),[['cancel','sell','when is false']]);assert.equal(records(g).at(-1)!.time,22000);
 assert.equal(coder.auto!.actions,4);assert.equal(coder.autoActions,4);assert.equal(publicState(g,22000).agents[0].program!.actions,4);
});

test('maxPosition is a hard cap that counts manual orders, and a strategy that crosses the book takes like any limit order',()=>{
 const g=game(),[coder,plain]=g.agents,c=g.atlasCenter!/100;
 intent(g,coder,{action:'place_order',side:'buy',type:'limit',quantity:8,price:c-far-5},2100);
 intent(g,coder,{action:'set_strategy',orders:[{side:'buy',price:String(px(c-far)),quantity:'10'}],maxPosition:10} as any,2100);advance(g,2500);
 assert.deepEqual(g.orders.filter(o=>o.agentId===coder.id).map(o=>[o.quantity,o.auto??0]),[[8,0],[2,1]],'8 manual + 2 automatic = the cap of 10');
 // Version 2 sells into Plain's bid: 2 per tick until the cap of 4 is reached, then it goes quiet.
 intent(g,coder,{action:'cancel_all'},2600);intent(g,plain,{action:'place_order',side:'buy',type:'limit',quantity:9,price:c-far-1},2600);
 const second:any=intent(g,coder,{action:'set_strategy',orders:[{side:'sell',price:String(px(c-far-1)),quantity:'2'}],maxPosition:4} as any,2600);assert.equal(second.version,2);
 advance(g,6000);
 assert.equal(coder.position,-4);assert.equal(coder.autoTakerQuantity,4);assert.equal(g.orders.filter(o=>o.agentId===coder.id).length,0);
 const taken=records(g).filter(r=>r.version===2);assert.deepEqual(taken.map(r=>[r.time,r.actions[0].action,r.actions[0].status,r.actions[0].filledQuantity]),[[3000,'place','filled',2],[3500,'place','filled',2]],'nothing more once the cap is reached');
});

test('a strategy can be replaced or cleared mid-game; only its own orders are touched',()=>{
 const g=game(),[coder,plain]=g.agents,c=g.atlasCenter!/100;
 const manual:any=intent(g,coder,{action:'place_order',side:'sell',type:'limit',quantity:3,price:c+far+3},2100);
 intent(g,coder,{action:'set_strategy',orders:[{side:'buy',price:String(px(c-far)),quantity:'5'},{side:'sell',price:String(px(c+far)),quantity:'5'}],maxPosition:20} as any,2100);advance(g,2500);
 assert.equal(g.orders.filter(o=>o.agentId===coder.id).length,3);
 // Fills on strategy orders are attributed; a partly filled quote is left to finish rather than re-queued.
 intent(g,plain,{action:'place_order',side:'buy',type:'limit',quantity:2,price:c+far},2600);advance(g,4000);
 assert.equal(coder.autoFills,1);assert.equal(coder.autoFilledQuantity,2);assert.equal(g.orders.find(o=>o.agentId===coder.id&&o.auto&&o.side==='sell')!.quantity,3);
 const before=g.orders.filter(o=>o.agentId===coder.id&&o.auto).map(o=>o.id);
 // Replacing is atomic: version 1's orders are canceled immediately and version 2 starts at the next tick.
 const second:any=intent(g,coder,{action:'set_strategy',orders:[{side:'buy',price:String(px(c-far-2)),quantity:'4'}],maxPosition:20} as any,4100);
 assert.equal(second.version,2);assert.equal(second.previousOrdersCanceled,2);assert.ok(!g.orders.some(o=>before.includes(o.id)));assert.ok(g.orders.some(o=>o.id===manual.orderId),'the manual order survives');
 advance(g,4500);assert.deepEqual(g.orders.filter(o=>o.agentId===coder.id&&o.auto).map(o=>[o.side,o.price,o.quantity,o.auto]),[['buy',Math.round((c-far-2)*100),4,2]]);
 const view:any=strategyView(g,coder,4600);assert.equal(view.strategy.version,2);assert.equal(view.strategy.status,'running');assert.equal(view.strategy.orders[0].resting.quantity,4);assert.equal(view.strategy.orders[0].now.price,px(c-far-2));assert.equal(view.strategy.recent.at(-1).action,'place');
 const cleared:any=intent(g,coder,{action:'clear_strategy'},4700);assert.deepEqual([cleared.status,cleared.version,cleared.canceled],['stopped',2,1]);
 assert.deepEqual(g.orders.filter(o=>o.agentId===coder.id).map(o=>o.id),[manual.orderId]);advance(g,9000);assert.equal(g.orders.filter(o=>o.agentId===coder.id).length,1,'a stopped strategy stays stopped');
 assert.throws(()=>intent(g,coder,{action:'clear_strategy'},9100),(e:any)=>e.status===404);
 assert.equal((intent(g,coder,{action:'set_strategy',orders:[{side:'buy',price:'1',quantity:'1'}],maxPosition:1} as any,9200) as any).version,3,'and can be installed again');
});

test('stopWhen stops the strategy, ticks never run at the deadline, and lazy replay equals stepping',()=>{
 const g=game(),[coder,plain]=g.agents,c=g.atlasCenter!/100;
 // Plain quotes around the center so Atlas trades and the strategy's inputs keep changing.
 intent(g,plain,{action:'place_order',side:'buy',type:'limit',quantity:200,price:c-2},2100);intent(g,plain,{action:'place_order',side:'sell',type:'limit',quantity:200,price:c+2},2100);
 intent(g,coder,{action:'set_strategy',vars:[{name:'fair',value:'or(atlasVwap,lastPrice,50)'}],orders:[{side:'buy',price:'fair-8-0.1*position',quantity:'3'},{side:'sell',price:'fair+8-0.1*position',quantity:'3'}],maxPosition:12,stopWhen:'remainingMs<10000'} as any,2100);
 const stepped=structuredClone(g);
 advance(g,62000);for(let t=2137;t<62000;t+=137)advance(stepped,t);advance(stepped,62000);
 const strip=(x:Game)=>JSON.stringify({...x,autoOut:undefined});
 assert.equal(strip(g),strip(stepped),'one jump and many small steps reach the same state');assert.deepEqual(g.autoOut,stepped.autoOut);
 assert.ok(g.botTicks!.some(t=>t.filledQuantity>0),'Atlas traded during the round');assert.ok(records(g).length>3,'the strategy re-quoted as Atlas prices moved');
 const stop=records(g).at(-1)!;assert.equal(stop.time,52500,'the first tick with less than 10 s left');assert.deepEqual(stop.actions.map(a=>a.action),['stop']);
 assert.equal(g.status,'finished');assert.equal(g.agents[0].auto!.status,'stopped');assert.equal(g.agents[0].auto!.stopReason,'stopWhen');assert.ok(records(g).every(r=>r.time<g.endsAt!&&(r.time-g.startedAt!)%STRATEGY_INTERVAL_MS===0));
 // A strategy still running at the close is marked stopped and its orders expire with the book.
 const h=game();intent(h,h.agents[0],{action:'set_strategy',orders:[{side:'buy',price:'1',quantity:'1'}],maxPosition:1} as any,2100);advance(h,62000);
 assert.equal(h.agents[0].auto!.stopReason,'game ended');assert.equal(h.autoAt,61500);assert.equal(h.orders.length,0);assert.equal(h.agents[0].expired,1);
});

test('formulas only see what the agent can already observe, and other agents never see a plan or program',()=>{
 const g=game(),[coder,plain]=g.agents,c=g.atlasCenter!/100;
 intent(g,plain,{action:'place_order',side:'sell',type:'limit',quantity:200,price:c},2100);intent(g,plain,{action:'place_order',side:'buy',type:'limit',quantity:200,price:c-0.5},2100);
 advance(g,40000);const env=strategyEnv(g,coder,40000),filled=g.botTicks!.filter(t=>t.filledQuantity>0);
 assert.ok(g.botTicks!.length>filled.length,'some arrivals did not fill and stay hidden');assert.equal(env.atlasBuys!+env.atlasSells!,filled.length);assert.equal(env.atlasBuyQty!+env.atlasSellQty!,filled.reduce((n,t)=>n+t.filledQuantity,0));
 assert.equal(env.bestBid,c-0.5);assert.equal(env.bestAsk,c);assert.equal(env.atlasBuyMax,c);assert.equal(env.atlasSellMin,c-0.5);assert.deepEqual(Object.keys(env).sort(),[...STRATEGY_VARIABLES].sort());
 intent(g,coder,{action:'set_plan',plan:'  Estimate C from Atlas fills, quote one tick inside, flatten in the last five seconds. '+'x'.repeat(700)},40100);
 intent(g,coder,{action:'set_strategy',note:'SECRET-NOTE',orders:[{side:'buy',price:'atlasSellMin-3',quantity:'2'}],maxPosition:6} as any,40100);
 assert.equal(coder.plan!.length,600);assert.ok(coder.plan!.startsWith('Estimate C'));
 const own:any=observation(g,coder,40200);assert.equal(own.plan,coder.plan);assert.equal(own.strategy.version,1);assert.ok(!('plan' in observation(g,plain,40200)));
 const header:any=headerSnapshot(own,0);assert.equal(header.plan,coder.plan);assert.equal(header.strategy.status,'running');assert.ok(!('strategy' in headerSnapshot(observation(g,plain,40200),0)));
 const seenByOthers=JSON.stringify([publicState(g,40200),observation(g,plain,40200)]);
 assert.ok(!seenByOthers.includes('Estimate C')&&!seenByOthers.includes('atlasSellMin')&&!seenByOthers.includes('SECRET-NOTE'));assert.equal(publicState(g,40200).agents[0].program!.versions,1);
});

test('up to ten agents per game',()=>{
 const specs=Array.from({length:MAX_AGENTS},(_,i)=>({name:'Agent'+i,provider:'external' as const}));
 assert.equal(MAX_AGENTS,10);const g=createGame('g','h','',specs,1000,42,SECRET,60_000,'hidden_center');assert.equal(g.agents.length,11);
 assert.throws(()=>addAgent(g,{name:'Eleventh',provider:'external'},'x','x',1000),/full \(10 agents\)/);assert.throws(()=>createGame('g','h','',[...specs,{name:'Eleventh',provider:'external'}],1000,42,SECRET,60_000,'hidden_center'),/up to 10/);
});

test('the extra tools and prompt reach only agents registered with them',async()=>{
 const extra=['set_plan','set_strategy','clear_strategy','get_strategy'];
 assert.equal(modelTools(),MODEL_TOOLS);assert.ok(!MODEL_TOOLS.some(t=>extra.includes(t.function.name)));assert.deepEqual(modelTools(true).map(t=>t.function.name).slice(MODEL_TOOLS.length),extra);
 for(const t of modelTools(true)){assert.ok(!('agentToken' in t.function.parameters.properties));assert.ok(!('gameId' in t.function.parameters.properties));}
 assert.equal(systemPrompt({a:1}),systemPrompt({a:1},false));assert.ok(!systemPrompt({a:1}).includes('set_strategy'));assert.ok(systemPrompt({a:1},true).includes(STRATEGY_PROMPT));assert.ok(READ_TOOLS.has('get_strategy'));
 const bodies:any[]=[],mock:typeof fetch=async(_url,init)=>{bodies.push(JSON.parse(init!.body as string));return Response.json({choices:[{message:{tool_calls:[{function:{name:'wait',arguments:'{}'}}]}}]});};
 const config={provider:'fireworks' as const,model:'m',apiKey:'k'};
 await complete(config,[{role:'user',content:'{}'}],1000,mock);await complete({...config,strategyTools:true},[{role:'user',content:'{}'}],1000,mock);
 assert.equal(bodies[0].tools.length,MODEL_TOOLS.length);assert.ok(!bodies[0].messages[0].content.includes('standing strategy'));
 assert.equal(bodies[1].tools.length,MODEL_TOOLS.length+4);assert.ok(bodies[1].messages[0].content.includes(STRATEGY_PROMPT));
});

test('recording a plan earns a follow-up round; installing a strategy ends the turn',async()=>{
 const reply=(name:string,args:object):Completion=>({...normalizeCompletion({choices:[{message:{tool_calls:[{id:name,type:'function',function:{name,arguments:JSON.stringify(args)}}]}}]}),latencyMs:0,usage:{promptTokens:0,completionTokens:0}});
 const script=[reply('set_plan',{plan:'Learn C, then quote around it.'}),reply('get_strategy',{}),reply('set_strategy',{orders:[],maxPosition:1})];let calls=0;
 const out=await converse({messages:[],deadline:Date.now()+10000,beforeCall:async()=>true,complete:async()=>script[calls++],commit:async()=>({replies:[]})});
 assert.equal(out.rounds,3);
 calls=0;const short=await converse({messages:[],deadline:Date.now()+10000,beforeCall:async()=>true,complete:async()=>[reply('set_strategy',{orders:[],maxPosition:1}),reply('wait',{})][calls++],commit:async()=>({replies:[]})});
 assert.equal(short.rounds,1);
});

test('the round log shows a strategy’s automatic actions and keeps them out of decision statistics',()=>{
 const g=game(),[coder,plain]=g.agents,c=g.atlasCenter!/100;
 const installed=act(g,coder,{action:'set_strategy',note:'wide quotes',orders:[{side:'buy',price:String(px(c-far)),quantity:'5'}],maxPosition:20},3000);
 act(g,plain,{action:'place_order',side:'sell',type:'limit',quantity:2,price:px(c-far)},3600);advance(g,62000);
 const row=(id:number,d:Partial<DecisionEntry>&{agentId:string;decisionId:string}):DecisionEntry=>({id,round:0,source:'server',createdAt:0,bookMoved:null,late:false,actions:null,...d} as DecisionEntry);
 const decisions=[row(1,{agentId:coder.id,decisionId:'d1',provider:'fireworks',model:'m',observationTime:2500,responseTime:2900,executionTime:3000,llmMs:400,stalenessMs:500,actions:[{action:'set_strategy',ok:true,version:1,orders:1,maxPosition:20}]}),
  ...records(g).map((r,i)=>row(10+i,{agentId:r.agentId,decisionId:'strategy:'+r.time,source:'strategy',executionTime:r.time,actions:r.actions,note:'strategy v'+r.version}))];
 const trajectories=[{agentId:coder.id,name:coder.name,messages:[
  {id:1,time:2500,decisionId:'d1',step:0,message:{role:'user' as const,content:JSON.stringify(headerSnapshot(observation(game(),game().agents[0],2500),0))}},
  {id:2,time:3000,decisionId:'d1',step:1,message:{role:'assistant' as const,content:'I will let a standing quote work while I think.',tool_calls:[{id:'c1',type:'function' as const,function:{name:'set_strategy',arguments:JSON.stringify({note:'wide quotes',orders:[{side:'buy',price:String(px(c-far)),quantity:'5'}],maxPosition:20})}}]}},
  {id:3,time:3000,decisionId:'d1',step:2,message:{role:'tool' as const,tool_call_id:'c1',content:JSON.stringify({action:'set_strategy',ok:true,result:installed})}}]}];
 const md=roundLog({state:publicState(g,62000),trajectories,decisions});
 for(const needle of [`- t+1.5s · **Coder** strategy v1: place buy 5 @ ${px(c-far).toFixed(2)}`,`set_strategy “wide quotes”: buy 5 @ ${px(c-far)}; maxPosition 20 → ✓ v1 running; right now: buy 5 @ ${px(c-far).toFixed(2)}`,'- Standing strategy: 1 version installed (now stopped), 1 automatic order actions on 1 ticks, 0 rejected; its orders had 1 maker fills (2 contracts) and took 0 contracts','· 1 decision rounds ·','LLM mean 400 ms'])assert.ok(md.includes(needle),'missing: '+needle+'\n'+md.slice(0,6000));
 assert.ok(!md.includes('### t+1.5s · Coder'),'a strategy tick is a list item, not a decision heading');
});

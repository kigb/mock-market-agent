import assert from 'node:assert/strict';
const base=process.env.ARENA_TEST_URL||'http://127.0.0.1:5173';
async function api(path,method='GET',body,token){const r=await fetch(base+'/api/arena/'+path,{method,headers:{...(body?{'Content-Type':'application/json'}:{}),...(token?{'X-Arena-Token':token}:{})},body:body?JSON.stringify(body):undefined});return {status:r.status,...await r.json()};}
async function rpc(name,args){const r=await fetch(base+'/mcp',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})});assert.equal(r.status,200);return (await r.json()).result;}
const modes=await api('modes');assert.equal(modes.defaultBotMode,'market_relative');assert.deepEqual(modes.modes.map(m=>m.id),['market_relative','hidden_center']);assert.equal((await api('rules')).scoringMode,'market_vwap');assert.equal((await api('rules?botMode=hidden_center')).scoringMode,'hidden_center');assert.equal((await api('rules?botMode=nope')).status,400);
const g=await api('games','POST',{agents:['A','B','C'].map(name=>({name,provider:'external'}))});assert.equal(g.status,201);assert.equal(g.state.botMode,'market_relative');assert.equal(g.state.durationMs,60000);assert.equal(g.state.rules.maxAbsPosition,20);assert.equal(g.state.atlas.center,null);assert.equal(g.state.atlas.secret,null);assert.ok(!JSON.stringify(g.state).includes('atlasSecret'));
const hidden=await api('games','POST',{botMode:'hidden_center',agents:[{name:'Hidden',provider:'external'}]});assert.equal(hidden.state.botMode,'hidden_center');assert.equal(hidden.state.durationMs,180000);assert.equal(hidden.state.scoringMode,'hidden_center');assert.equal((await api('games','POST',{botMode:'nope'})).status,400);
const mcp=await rpc('create_game',{botMode:'market_relative',durationSeconds:120});assert.equal(mcp.isError,false);assert.equal(mcp.structuredContent.state.botMode,'market_relative');assert.equal(mcp.structuredContent.state.durationMs,120000);
const id=g.state.id,host=g.hostToken,[a,b,c]=g.agentTokens;
const perGame=await rpc('get_rules',{gameId:id,agentToken:a.token});assert.equal(perGame.structuredContent.botMode,'market_relative');assert.equal((await rpc('get_rules',{gameId:hidden.state.id,agentToken:hidden.agentTokens[0].token})).structuredContent.scoringMode,'hidden_center');
await api('games/'+id+'/start','POST',{},host);
const order=(who,body)=>api('games/'+id+'/orders','POST',body,who.token);
const first=await order(a,{side:'buy',quantity:20,price:10,requestId:'initial'});assert.equal(first.status,200);const cap=await api('games/'+id+'/book','GET',undefined,a.token);assert.equal(cap.result.riskCapacity.buyCapacity,0);
const denied=await order(a,{side:'buy',quantity:1,price:10});assert.equal(denied.status,400);assert.match(denied.error,/POSITION_LIMIT/);assert.equal((await order(a,{side:'buy',quantity:20,price:11,requestId:'initial'})).status,409);
const badReplace=await api('games/'+id+'/replace','POST',{orderId:first.result.orderId,side:'buy',price:11,quantity:21},a.token);assert.equal(badReplace.status,400);assert.ok((await api('games/'+id+'/book','GET',undefined,a.token)).result.openOrders.some(o=>o.id===first.result.orderId));
const replaced=await rpc('replace_order',{gameId:id,agentToken:a.token,orderId:first.result.orderId,side:'buy',quantity:20,price:11});assert.equal(replaced.isError,false);assert.equal(replaced.structuredContent.result.replacedOrderId,first.result.orderId);
await api('games/'+id+'/cancel','POST',{},a.token);
await order(b,{side:'sell',quantity:2,price:60});await order(c,{side:'sell',quantity:3,price:60.03});
const post=await order(a,{side:'buy',quantity:4,price:60.02,postOnly:true});assert.equal(post.status,400);assert.match(post.error,/POST_ONLY_WOULD_CROSS/);
assert.equal((await order(a,{side:'buy',type:'market',quantity:4})).status,400);
const ioc=await order(a,{side:'buy',quantity:4,price:60.02,timeInForce:'IOC',requestId:'ioc'});assert.equal(ioc.result.filledQuantity,2);assert.equal(ioc.result.canceledQuantity,2);assert.equal(ioc.result.remainingQuantity,0);
const again=await order(a,{side:'buy',quantity:4,price:60.02,timeInForce:'IOC',requestId:'ioc'});assert.equal(again.result.orderId,ioc.result.orderId);assert.equal(again.state.volume,ioc.state.volume);
assert.equal((await api('games/'+id+'/mode','POST',{botMode:'hidden_center'},host)).status,404);
const log=await fetch(base+'/api/arena/games/'+id+'/log',{headers:{'X-Arena-Token':host}}).then(r=>r.text());assert.ok(log.includes('Market-relative Atlas · no hidden value'));assert.ok(!log.includes('center hidden until the close'));
const exported=await api('games/'+id+'/export','POST',{},host);assert.equal(exported.results.botMode,'market_relative');assert.ok(!JSON.stringify(exported).includes(host));
console.log('PASS: REST/MCP mode discovery, per-game defaults/rules, immutable mode, reserved positions, atomic replace, protected IOC/post-only, idempotency conflicts, mode logs and exports.');

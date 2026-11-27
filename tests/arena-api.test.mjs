import assert from 'node:assert/strict';
const url=process.env.ARENA_TEST_URL||'http://127.0.0.1:5173';
const api=async(path,method='GET',body,token)=>{const r=await fetch(url+'/api/arena/'+path,{method,headers:{...(body?{'Content-Type':'application/json'}:{}),...(token?{'X-Arena-Token':token}:{})},body:body?JSON.stringify(body):undefined});const d=await r.json();return {status:r.status,...d};};
const rpc=async(method,params)=>{const r=await fetch(url+'/mcp',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});assert.equal(r.status,200);return r.json();};
const rules=await api('rules?botMode=hidden_center');assert.equal(rules.ticker,'MOCK');assert.equal(rules.durationSeconds,180);assert.deepEqual(rules.durationRange,[30,600]);assert.equal(rules.openingPrice,null);assert.equal(rules.botMeanIntervalSeconds,2);assert.equal(rules.scoringMode,'hidden_center');assert.equal(rules.botExecutionMode,'limit_ioc');assert.deepEqual(rules.botCenterRange,[20,80]);assert.equal(rules.botLimitBand,5);assert.equal(rules.rulesVersion,'hidden-center-v2');assert.equal(rules.botLimitDistribution.degreesOfFreedom,1.5);assert.deepEqual(rules.botQuantityRange,[1,5]);
const discovery=await rpc('server/discover',{});assert.ok(discovery.result.supportedVersions.includes('2026-07-28'));
const init=await rpc('initialize',{protocolVersion:'2025-06-18'});assert.equal(init.result.protocolVersion,'2025-06-18');
const tools=await rpc('tools/list',{});assert.ok(tools.result.tools.find(t=>t.name==='place_order'));assert.ok(tools.result.tools.find(t=>t.name==='record_decision'));
const created=await api('games','POST',{botMode:'hidden_center',agents:[{name:'Alice API',provider:'external'},{name:'Bob API',provider:'external'},{name:'Charlie API',provider:'external'},{name:'Dara API',provider:'external'}]});assert.equal(created.status,201);assert.equal(created.state.lastPrice,null);assert.deepEqual(created.state.series,[]);assert.equal(created.state.settlementPrice,null);assert.equal(created.state.valuation.price,null);assert.equal(created.state.valuation.source,'unpriced');assert.equal(created.state.atlas.maxAttempts,null);assert.equal(created.state.atlas.center,null);assert.equal(created.state.atlas.executionMode,'limit_ioc');assert.deepEqual(created.state.atlas.ticks,[]);
const {id}=created.state,host=created.hostToken,[a,b,c,d]=created.agentTokens;
assert.equal((await api('games/'+id)).status,401);const firstRead=await api('games/'+id,'GET',undefined,host),secondRead=await api('games/'+id,'GET',undefined,host);assert.equal(firstRead.revision,secondRead.revision);assert.equal(firstRead.revision,0);
assert.equal((await api('games/'+id+'/start','POST',{},a.token)).status,401);
assert.equal((await api('games/'+id+'/orders','POST',{side:'buy',type:'limit',quantity:1,price:49},a.token)).status,409);
const started=await api('games/'+id+'/start','POST',{},host);assert.equal(started.state.status,'running');assert.equal(started.state.endsAt-started.state.startedAt,180000);assert.equal(started.state.durationMs,180000);assert.equal(started.state.book.bids.length,0);
// Atlas limits stay within 15–85, so these test quotes never trade with it.
const results=await Promise.all(Array.from({length:16},(_,i)=>api('games/'+id+'/orders','POST',{side:'buy',type:'limit',price:10+i*.01,quantity:1,requestId:'concurrent-'+i},[a,b,c,d][i%4].token)));assert.ok(results.every(x=>x.status===200));
const observed=await api('games/'+id+'/book','GET',undefined,a.token);assert.equal(observed.result.openOrders.length,4);assert.equal(observed.result.rules.botLimitBand,5);assert.equal(observed.result.atlas.executionMode,'limit_ioc');assert.equal(observed.result.atlas.center,null);assert.ok(!JSON.stringify(observed.state).includes(a.token));
const other=await api('games/'+id+'/orders/'+observed.result.openOrders[0].id,'DELETE',undefined,b.token);assert.equal(other.status,404);
const canceled=await api('games/'+id+'/orders/'+observed.result.openOrders[0].id,'DELETE',undefined,a.token);assert.equal(canceled.status,200);
const mcp=await rpc('tools/call',{name:'place_order',arguments:{gameId:id,agentToken:a.token,side:'sell',quantity:7,type:'limit',price:95,requestId:'mcp-quote'}});assert.equal(mcp.result.isError,false);assert.ok(mcp.result.structuredContent.result.orderId);
const invalid=await rpc('tools/call',{name:'place_order',arguments:{gameId:id,agentToken:a.token,side:'buy',quantity:1.5,price:101}});assert.equal(invalid.result.isError,true);
const duplicate=await api('games/'+id+'/orders','POST',{side:'sell',quantity:7,type:'limit',price:95,requestId:'mcp-quote'},a.token);assert.equal(duplicate.result.orderId,mcp.result.structuredContent.result.orderId);
await api('games/'+id+'/cancel','POST',{},a.token);assert.equal((await api('games/'+id+'/book','GET',undefined,a.token)).result.openOrders.length,0);
const hist=await rpc('tools/call',{name:'get_atlas_history',arguments:{gameId:id,agentToken:a.token,limit:5}});assert.equal(hist.result.isError,false);assert.ok(Array.isArray(hist.result.structuredContent.result.ticks)&&typeof hist.result.structuredContent.result.total==='number');const fillsRead=await rpc('tools/call',{name:'get_fills',arguments:{gameId:id,agentToken:a.token,limit:3}});assert.equal(fillsRead.result.isError,false);assert.ok(Array.isArray(fillsRead.result.structuredContent.result.fills));
const tokenUsage=await rpc('tools/call',{name:'record_decision',arguments:{gameId:id,agentToken:a.token,latencyMs:123,inputTokens:10,outputTokens:5,requestId:'external-metrics'}});assert.equal(tokenUsage.result.isError,false);assert.equal(tokenUsage.result.structuredContent.state.agents[0].calls,1);
assert.equal(tokenUsage.result.structuredContent.state.agents[0].cachedPromptTokens,null);
for(const [requestId,inputTokens,cachedPromptTokens] of [['cache-hit',8,6],['cache-miss',4,0],['cache-hit',8,6]]){
 const res=await api('games/'+id+'/metrics','POST',{requestId,latencyMs:10,inputTokens,cachedPromptTokens},a.token);
 assert.equal(res.status,200);
}
const badCache=await api('games/'+id+'/metrics','POST',{requestId:'invalid',latencyMs:10,inputTokens:2,cachedPromptTokens:3},a.token);
assert.equal(badCache.status,400);
const cacheRows=await api('games/'+id+'/decisions','GET',undefined,a.token);
assert.deepEqual(cacheRows.decisions.map(r=>r.cachedPromptTokens),[null,6,0]);
const origin=await fetch(url+'/mcp',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://evil.example'},body:'{}'});assert.equal(origin.status,403);
const exported=await fetch(url+'/api/arena/games/'+id+'/export',{method:'POST',headers:{'X-Arena-Token':host}});assert.equal(exported.status,200);assert.ok(exported.headers.get('Content-Disposition').includes('attachment'));const report=await exported.json();assert.ok(!JSON.stringify(report).includes(host));assert.equal(report.rules.ticker,'MOCK');
const cacheSeat=report.results.agents.find(seat=>seat.id===a.id);
assert.deepEqual([cacheSeat.cachedPromptTokens,cacheSeat.cacheReportedPromptTokens,cacheSeat.promptTokens],[6,12,22]);
assert.equal(report.decisions.find(row=>row.decisionId==='cache-hit').cachedPromptTokens,6);
console.log('PASS: REST + MCP discovery, registration, ownership, token privacy, 16 concurrent orders, cancellations, duplicate receipts, origin checks, and external telemetry.');

const defaults=await api('defaults');assert.equal(defaults.agents.length,9);assert.equal(new Set(defaults.agents.map(a=>a.model)).size,6);assert.equal(typeof defaults.available,'boolean');assert.ok(!JSON.stringify(defaults).includes('apiKey'));
const classic=await api('defaults?lineup=classic');assert.equal(classic.status,200);assert.equal(classic.agents.length,6);
assert.equal(classic.agents.find(a=>a.preset==='fw-kimi-pro').reasoningEffort,'low');
assert.equal(defaults.agents.find(a=>a.preset==='fw-kimi-pro-high').reasoningEffort,'high');
assert.deepEqual((await api('defaults?lineup=strategy')).agents,defaults.agents);assert.equal((await api('defaults?lineup=other')).status,400);
assert.equal(rules.maxAgents,10);assert.equal((await api('rules?botMode=market_relative')).maxAgents,10);
const classicGame=await api('games','POST',{agents:classic.agents});
assert.equal(classicGame.status,201);assert.equal(classicGame.state.agents.length,6);assert.ok(classicGame.state.agents.every(a=>!a.strategyTools));
const presets=defaults.agents;
assert.equal((await api('games','POST',{botMode:'hidden_center',agents:[{...presets[0],model:'other'}]})).status,400);
assert.equal((await api('games','POST',{botMode:'hidden_center',agents:[{...presets[0]},{...presets[0],name:'Copy'}]})).status,400);
const presetGame=await api('games','POST',{botMode:'hidden_center',agents:presets});assert.equal(presetGame.status,201);assert.equal(presetGame.state.agents.length,9);
await api('games/'+presetGame.state.id+'/start','POST',{},presetGame.hostToken);
const wrongConfig=await api('games/'+presetGame.state.id+'/decide','POST',{config:{provider:presets[0].provider,model:presets[0].model,apiKey:'TEST_ONLY',prompt:'override'}},presetGame.agentTokens[0].token);assert.equal(wrongConfig.status,400);assert.match(wrongConfig.error,/fixed server configuration/);
const custom=await api('games','POST',{botMode:'hidden_center',agents:[{name:'Own key',provider:presets[0].provider,model:presets[0].model}]});await api('games/'+custom.state.id+'/start','POST',{},custom.hostToken);assert.equal((await api('games/'+custom.state.id+'/decide','POST',{},custom.agentTokens[0].token)).status,400);
console.log('PASS: nine fixed default slots, no duplicate slots, no client override, and custom agents never inherit the shared key.');

const memoryGame=await api('games','POST',{botMode:'hidden_center',agents:Array.from({length:4},(_,i)=>({name:'Memory '+i,provider:'baseline',strategy:'maker',intervalMs:500}))});
assert.equal(memoryGame.status,201);const memoryId=memoryGame.state.id;
await api('games/'+memoryId+'/start','POST',{},memoryGame.hostToken);
const memoryTurns=await Promise.all(memoryGame.agentTokens.map(a=>api('games/'+memoryId+'/decide','POST',{},a.token)));
assert.ok(memoryTurns.every(t=>t.status===200));
for(const agent of memoryGame.agentTokens){
 const own=await api('games/'+memoryId+'/history?agentId='+agent.id,'GET',undefined,agent.token);assert.equal(own.status,200);assert.equal(own.messages.length,5);assert.equal(own.messages[0].message.role,'user');const snapshot=JSON.parse(own.messages[0].message.content);assert.ok('bestBid' in snapshot&&'atlasFillsSinceLastTurn' in snapshot&&!('book' in snapshot)&&!('rules' in snapshot),'the model receives the compact header');assert.equal(own.messages[1].message.role,'assistant');assert.equal(own.messages[1].message.tool_calls.length,3);
 assert.deepEqual(own.messages.slice(2).map(e=>e.message.tool_call_id),own.messages[1].message.tool_calls.map(c=>c.id));assert.ok(own.messages.slice(2).every(e=>JSON.parse(e.message.content).ok));assert.ok(!JSON.stringify(own).includes(agent.token));
 const asHost=await api('games/'+memoryId+'/history?agentId='+agent.id,'GET',undefined,memoryGame.hostToken);assert.deepEqual(asHost.messages,own.messages);
}
assert.equal((await api('games/'+memoryId+'/history?agentId='+memoryGame.agentTokens[1].id,'GET',undefined,memoryGame.agentTokens[0].token)).status,403);
assert.equal((await api('games/'+memoryId+'/history?agentId='+memoryGame.agentTokens[0].id)).status,401);
await new Promise(resolve=>setTimeout(resolve,520));
await api('games/'+memoryId+'/decide','POST',{},memoryGame.agentTokens[0].token);
const historyAgain=await api('games/'+memoryId+'/history','GET',undefined,memoryGame.agentTokens[0].token);assert.equal(historyAgain.messages.length,10);assert.equal(historyAgain.messages[0].step,0);assert.notEqual(historyAgain.messages[0].decisionId,historyAgain.messages[5].decisionId);
const allHistories=await fetch(url+'/api/arena/games/'+memoryId+'/export',{method:'POST',headers:{'X-Arena-Token':memoryGame.hostToken}}).then(r=>r.json());assert.equal(allHistories.trajectories.length,4);assert.equal(allHistories.trajectories[0].messages.length,10);
const privateExport=await fetch(url+'/api/arena/games/'+memoryId+'/export',{method:'POST',headers:{'X-Arena-Token':memoryGame.agentTokens[0].token}}).then(r=>r.json());assert.equal(privateExport.trajectories.length,1);assert.equal(privateExport.trajectories[0].agentId,memoryGame.agentTokens[0].id);
console.log('PASS: concurrent transcript writes are atomic, full history survives subsequent turns, host access works, and opponents cannot read or export another agent conversation.');

// Commit-reveal, per-round decision metrics (server and self-reported), ownership, export, and the finalization sweep.
assert.match(created.state.atlas.commitment,/^[0-9a-f]{64}$/);assert.equal(created.state.atlas.secret,null);assert.equal(created.state.atlas.center,null);assert.match(rules.botRandomness,/SHA-256\(secret \|\| seed/);
const metricsRows=await api('games/'+memoryId+'/decisions','GET',undefined,memoryGame.hostToken);assert.equal(metricsRows.status,200);assert.ok(metricsRows.decisions.length>=5);assert.equal(metricsRows.agents.length,4);
const first=metricsRows.decisions.find(d=>d.agentId===memoryGame.agentTokens[0].id);assert.equal(first.source,'server');assert.equal(first.provider,'baseline');assert.equal(first.round,0);assert.ok(first.observationTime<=first.executionTime);assert.equal(first.stalenessMs,first.executionTime-first.observationTime);assert.equal(first.llmMs,null);assert.equal(first.responseTime,null);assert.equal(first.actions.length,3);assert.equal(first.actions[0].action,'cancel_all');assert.ok(first.actions.every(a=>a.ok));assert.ok(first.actions.slice(1).every(a=>a.action==='place_order'&&typeof a.marketableAtObservation==='boolean'&&typeof a.status==='string'));assert.ok(first.observationRevision<first.executionRevision);assert.equal(typeof first.casRetries,'number');assert.equal(first.late,false);assert.ok(!JSON.stringify(metricsRows).includes(memoryGame.hostToken));
const ownRows=await api('games/'+memoryId+'/decisions?agentId='+memoryGame.agentTokens[0].id,'GET',undefined,memoryGame.agentTokens[0].token);assert.equal(ownRows.status,200);assert.ok(ownRows.decisions.length>=2);assert.ok(ownRows.decisions.every(d=>d.agentId===memoryGame.agentTokens[0].id));
assert.equal((await api('games/'+memoryId+'/decisions?agentId='+memoryGame.agentTokens[1].id,'GET',undefined,memoryGame.agentTokens[0].token)).status,403);
assert.equal((await api('games/'+memoryId+'/decisions')).status,401);
const stamped=await api('games/'+id+'/metrics','POST',{latencyMs:321,inputTokens:7,outputTokens:3,observationTime:observed.result.serverTime,responseTime:Date.now(),executionTime:observed.state.now+5,round:0,model:'external-fixture',reasoningEffort:'low',actions:[{action:'wait',ok:true}],note:'Waiting for a quote before committing.',reasoning:'Hidden chain of thought: no quotes yet, so do nothing.',requestId:'external-stamped'},b.token);assert.equal(stamped.status,200);assert.equal(stamped.result.recorded,true);
const external=await api('games/'+id+'/decisions','GET',undefined,host);const row=external.decisions.find(d=>d.decisionId==='external-stamped');assert.equal(row.source,'self_reported');assert.equal(row.provider,'external');assert.equal(row.model,'external-fixture');assert.equal(row.reasoningEffort,'low');assert.equal(row.stalenessMs,observed.state.now+5-observed.result.serverTime);assert.equal(row.llmMs,321);assert.equal(row.promptTokens,7);assert.deepEqual(row.actions,[{action:'wait',ok:true}]);assert.equal(row.note,'Waiting for a quote before committing.');assert.equal(row.reasoning,'Hidden chain of thought: no quotes yet, so do nothing.');
assert.equal((await api('games/'+id+'/metrics','POST',{latencyMs:1,observationTime:'soon',requestId:'bad-stamp'},b.token)).status,400);
assert.equal((await api('games/'+id+'/metrics','POST',{latencyMs:1,round:12,requestId:'bad-round'},b.token)).status,400);
const exportedAgain=await fetch(url+'/api/arena/games/'+memoryId+'/export',{method:'POST',headers:{'X-Arena-Token':memoryGame.hostToken}}).then(r=>r.json());assert.ok(exportedAgain.decisions.length>=5);assert.ok(!JSON.stringify(exportedAgain).includes(memoryGame.hostToken));
const privateAgain=await fetch(url+'/api/arena/games/'+memoryId+'/export',{method:'POST',headers:{'X-Arena-Token':memoryGame.agentTokens[0].token}}).then(r=>r.json());assert.ok(privateAgain.decisions.every(d=>d.agentId===memoryGame.agentTokens[0].id));
const sweep=await api('finalize','POST',{});assert.equal(sweep.status,200);assert.ok(Array.isArray(sweep.finalized));assert.equal(typeof sweep.checked,'number');
console.log('PASS: commitment published before the close, server and self-reported decision rows carry three timestamps and outcomes, metrics ownership holds, exports include decisions, and the finalize sweep responds.');

// Per-game round length through REST and MCP, with bounds.
const shortGame=await api('games','POST',{botMode:'hidden_center',durationSeconds:30,agents:[{name:'Short',provider:'external'}]});assert.equal(shortGame.status,201);assert.equal(shortGame.state.durationMs,30000);assert.equal(shortGame.state.remainingMs,30000);
assert.equal((await api('games','POST',{botMode:'hidden_center',durationSeconds:10})).status,400);assert.equal((await api('games','POST',{botMode:'hidden_center',durationSeconds:'long'})).status,400);
const mcpGame=await rpc('tools/call',{name:'create_game',arguments:{seed:1,durationSeconds:120}});assert.equal(mcpGame.result.isError,false);assert.equal(mcpGame.result.structuredContent.state.durationMs,120000);
console.log('PASS: rounds default to 180 s, durationSeconds is honoured by REST and MCP, and out-of-range lengths are rejected.');

// Round log: markdown for the host (all agents) and for an agent token (own decisions only), plus the markdown export.
const hostLog=await fetch(url+'/api/arena/games/'+memoryId+'/log',{headers:{'X-Arena-Token':memoryGame.hostToken}});assert.equal(hostLog.status,200);assert.match(hostLog.headers.get('content-type'),/markdown/);const hostText=await hostLog.text();
assert.match(hostText,/^# Round log/);assert.ok(hostText.includes('## Decision timeline')&&hostText.includes('## Market timeline')&&hostText.includes('## Agents'));assert.ok(/### t\+[\d.]+s · Memory 0/.test(hostText)&&/### t\+[\d.]+s · Memory 1/.test(hostText));assert.ok(hostText.includes('cancel_all → ✓ canceled'));assert.ok(!hostText.includes(memoryGame.hostToken)&&!hostText.includes(memoryGame.agentTokens[0].token));
const ownText=await fetch(url+'/api/arena/games/'+memoryId+'/log',{headers:{'X-Arena-Token':memoryGame.agentTokens[0].token}}).then(r=>r.text());assert.ok(/### t\+[\d.]+s · Memory 0/.test(ownText));assert.ok(!/### t\+[\d.]+s · Memory 1/.test(ownText));assert.ok(ownText.includes('| Memory 1 |'));
assert.equal((await fetch(url+'/api/arena/games/'+memoryId+'/log')).status,401);
const mdExport=await fetch(url+'/api/arena/games/'+memoryId+'/export?format=markdown',{method:'POST',headers:{'X-Arena-Token':memoryGame.hostToken}});assert.equal(mdExport.status,200);assert.ok(mdExport.headers.get('Content-Disposition').includes('round-log.md'));assert.match(await mdExport.text(),/^# Round log/);
const externalLog=await fetch(url+'/api/arena/games/'+id+'/log',{headers:{'X-Arena-Token':host}}).then(r=>r.text());assert.ok(externalLog.includes('Said: Waiting for a quote before committing.'));assert.ok(externalLog.includes('Thought: Hidden chain of thought: no quotes yet, so do nothing.'));const agentHistory=await api('games/'+id+'/history','GET',undefined,b.token);assert.ok(!JSON.stringify(agentHistory).includes('Hidden chain of thought'),'reasoning never enters the conversation');
console.log('PASS: round log narrates decisions chronologically, respects agent scoping, exports as markdown, and shows self-reported notes.');

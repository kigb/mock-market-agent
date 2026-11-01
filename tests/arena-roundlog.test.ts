import test from 'node:test';
import assert from 'node:assert/strict';
import {createGame,startGame,intent,advance,observation,publicState} from '../lib/arena/engine.ts';
import {roundLog} from '../lib/arena/roundlog.ts';
import type {DecisionEntry} from '../lib/arena/store.ts';
const SECRET='00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
test('the round log narrates what agents saw, said, and did, with Atlas and external agents interleaved',()=>{
 const g=createGame('game_00000000-0000-0000-0000-000000000000','host','',[{name:'Thinker',provider:'sail',model:'zai-org/GLM-5.3-Flash'},{name:'Outsider',provider:'external'}],1000,42,SECRET,60_000);startGame(g,2000);
 const [thinker,outsider]=g.agents;const c=g.atlasCenter!/100;
 const seen=observation(g,thinker,2500);
 const placed=intent(g,thinker,{action:'place_order',side:'sell',type:'limit',quantity:5,price:c+1},3000,'r1');
 const outsiderOrder=intent(g,outsider,{action:'place_order',side:'buy',type:'limit',quantity:3,price:c-1},3500,'r2');
 advance(g,62000);const state=publicState(g,62000);
 const trajectories=[{agentId:thinker.id,name:thinker.name,messages:[
  {id:1,time:2500,decisionId:'d1',step:0,message:{role:'user' as const,content:JSON.stringify(seen)}},
  {id:2,time:3000,decisionId:'d1',step:1,message:{role:'assistant' as const,content:'Atlas has not traded yet, so I will offer above my estimate of the center.',tool_calls:[{id:'c1',type:'function' as const,function:{name:'place_order',arguments:JSON.stringify({side:'sell',type:'limit',quantity:5,price:c+1})}}]}},
  {id:3,time:3000,decisionId:'d1',step:2,message:{role:'tool' as const,tool_call_id:'c1',content:JSON.stringify({action:'place_order',ok:true,result:placed})}},
  {id:4,time:9000,decisionId:'d2',step:0,message:{role:'user' as const,content:JSON.stringify({kind:'provider_error',serverTime:9000,error:'Provider timed out. The game clock keeps running.'})}}]}];
 const decisions:DecisionEntry[]=[
  {id:1,agentId:thinker.id,decisionId:'d1',round:0,source:'server',provider:'sail',model:'zai-org/GLM-5.3-Flash',reasoningEffort:'low',observationTime:2500,responseTime:2900,executionTime:3000,llmMs:400,executionMs:100,stalenessMs:500,casRetries:0,promptTokens:1200,completionTokens:40,observedBestBid:null,observedBestAsk:null,executedBestBid:null,executedBestAsk:null,bookMoved:false,late:false,actions:[{action:'place_order',side:'sell',type:'limit',quantity:5,price:c+1,ok:true,status:'open',filledQuantity:0,marketableAtObservation:false}],note:'Atlas has not traded yet, so I will offer above my estimate of the center.',reasoning:'Step one: the book is empty.\nStep two: C is uniform on 20 to 80, so 50 is my prior.\nStep three: offer above it and wait for Atlas.',createdAt:3000},
  {id:2,agentId:outsider.id,decisionId:'ext-1',round:0,source:'self_reported',provider:'external',model:'my-bot',reasoningEffort:null,observationTime:3400,responseTime:3450,executionTime:3500,llmMs:50,executionMs:50,stalenessMs:100,casRetries:null,promptTokens:0,completionTokens:0,observedBestBid:null,observedBestAsk:c+1,executedBestBid:null,executedBestAsk:null,bookMoved:null,late:false,actions:[{action:'place_order',side:'buy',type:'limit',quantity:3,price:c-1,ok:true,status:'open',filledQuantity:0}],note:'Bidding one dollar under the only ask.',createdAt:3500}];
 const md=roundLog({state,trajectories,decisions});
 for(const needle of ['# Round log','## Final leaderboard','## Market timeline','## Decision timeline','## Agents','### t+1.0s · Thinker · LLM 0.4 s · staleness 0.5 s','Saw (t+0.5s): last — · bid — / ask —','Said: Atlas has not traded yet','Thought: Step one: the book is empty. Step two: C is uniform on 20 to 80, so 50 is my prior. Step three: offer above it and wait for Atlas.','- place_order sell 5 @ '+(c+1).toFixed(2)+' → ✓ open','### t+7.0s · Thinker · provider error','### t+1.5s · Outsider · LLM 0.1 s · staleness 0.1 s · self-reported','Said: Bidding one dollar under the only ask.','**Atlas**','hidden center C = '+c.toFixed(2),'secret revealed','| 1 | ','Actions: place_order ×1'])assert.ok(md.includes(needle),needle);
 assert.ok(!md.includes(thinker.token)&&!md.includes(g.hostToken));
 assert.ok(md.indexOf('### t+1.0s · Thinker')<md.indexOf('### t+1.5s · Outsider'),'chronological order');
 assert.ok(outsiderOrder&&typeof outsiderOrder==='object');
 // Agent-scoped view: only one trajectory, the other agent still appears on the public leaderboard.
 const own=roundLog({state,trajectories,decisions:decisions.filter(d=>d.agentId===thinker.id)});
 assert.ok(own.includes('| Outsider |')||own.includes('| Outsider'));assert.ok(!own.includes('### t+1.5s · Outsider'));
});

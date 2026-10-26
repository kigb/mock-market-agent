import {env} from 'cloudflare:workers';
import {DEFAULT_AGENTS} from '../../../../lib/arena/presets';
import {ArenaError,RULES,observation,type AgentSpec} from '../../../../lib/arena/engine';
import {agentAuth,authenticate,change,transcript,gameTranscripts} from '../../../../lib/arena/store';
import {makeGame,callTool,decision} from '../../../../lib/arena/service';
import {MCP_TOOLS} from '../../../../lib/arena/protocol';
import {infer,type ModelConfig} from '../../../../lib/arena/providers';
export const dynamic='force-dynamic';
const json=(data:unknown,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
type Context={params:Promise<{path:string[]}>};
export async function GET(request:Request,context:Context){return route(request,context);}
export async function POST(request:Request,context:Context){return route(request,context);}
export async function DELETE(request:Request,context:Context){return route(request,context);}
async function route(request:Request,context:Context){
 try{
  const {path}=await context.params,method=request.method;
  const token=request.headers.get('X-Arena-Token')||request.headers.get('X-Agent-Token')||'';
  if(path[0]==='games'&&path[2]==='export'&&method==='POST'){
   const origin=request.headers.get('Origin');if(origin&&origin!==new URL(request.url).origin)throw new ArenaError('Invalid Origin.',403);
   const type=request.headers.get('Content-Type')||'';
   const form=type.includes('application/x-www-form-urlencoded')?await request.formData():null;
   const auth=token||(form?.get('token') as string)||'';
   const data=await change(path[1],g=>{const viewer=authenticate(g,auth);return g.agents.filter(a=>a.id!=='$atlas'&&(!viewer||a.id===viewer.id)).map(a=>({id:a.id,name:a.name}));});
   const trajectories=(await gameTranscripts(path[1],data.result.map(a=>a.id))).map(t=>({...t,name:data.result.find(a=>a.id===t.agentId)!.name}));
   return new Response(JSON.stringify({rules:data.state.rules,results:data.state,trajectories},null,2),{headers:{'Content-Type':'application/json','Content-Disposition':`attachment; filename="${data.state.id}-results.json"`,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
  }
  let body:any={};if(method==='POST'){const text=await request.text();if(text.length>64000)throw new ArenaError('Request too large.',413);try{body=JSON.parse(text);}catch{throw new ArenaError('Send a JSON request body.');}if(!body||typeof body!=='object'||Array.isArray(body))throw new ArenaError('Send a JSON object.');}
  if(path[0]==='defaults'&&method==='GET')return json({agents:DEFAULT_AGENTS,available:!!env.SAIL_API_KEY});
  if(path[0]==='rules'&&method==='GET')return json(RULES);
  if(path[0]==='tools'&&method==='GET')return json({tools:MCP_TOOLS});
  if(path[0]==='providers'&&path[1]==='test'&&method==='POST'){
   const r=await infer(body as ModelConfig,{instruction:'Call wait with reason connection test. Do not trade.'},12000);return json({ok:true,latencyMs:r.latencyMs,usage:r.usage});
  }
  if(path[0]!=='games')throw new ArenaError('Endpoint not found.',404);
  if(path.length===1&&method==='POST')return json(await makeGame((body.agents??[]) as AgentSpec[],body.seed??42,request.headers.get('oai-authenticated-user-id')||''),201);
  const id=path[1],resource=path[2];
  if(resource==='history'&&method==='GET'){const requested=new URL(request.url).searchParams.get('agentId');const checked=await change(id,g=>{const viewer=authenticate(g,token),agentId=requested||viewer?.id;const a=g.agents.find(a=>a.id===agentId&&a.id!=='$atlas');if(!a)throw new ArenaError('Select a competing agent.',404);if(viewer&&viewer.id!==a.id)throw new ArenaError('You can only read your own conversation.',403);return {agentId:a.id,name:a.name};});return json({...checked.result,messages:await transcript(id,checked.result.agentId)});}
  if(!resource&&method==='GET')return json(await change(id,(g)=>{authenticate(g,token);return {}; }));
  if(resource==='start'&&method==='POST')return json(await callTool('start_game',{gameId:id,hostToken:token}));
  if(resource==='agents'&&method==='POST')return json(await callTool('register_agent',{gameId:id,hostToken:token,name:body.name}));
  if(resource==='book'&&method==='GET')return json(await change(id,(g,now)=>observation(g,agentAuth(g,token),now)));
  if(resource==='orders'&&method==='POST')return json(await callTool('place_order',{...body,gameId:id,agentToken:token}));
  if(resource==='orders'&&path[3]&&method==='DELETE')return json(await callTool('cancel_order',{gameId:id,agentToken:token,orderId:path[3]}));
  if(resource==='cancel'&&method==='POST')return json(await callTool(body.orderId?'cancel_order':'cancel_all',{...body,gameId:id,agentToken:token}));
  if(resource==='results'&&method==='GET')return json(await callTool('get_results',{gameId:id,token}));
  if(resource==='metrics'&&method==='POST')return json(await callTool('record_decision',{...body,gameId:id,agentToken:token}));
  if(resource==='decide'&&method==='POST')return json(await decision(id,token,body.config));
  throw new ArenaError('Endpoint not found.',404);
 }catch(error){return json({error:error instanceof ArenaError?error.message:'The arena request could not be completed. Please retry.',code:error instanceof ArenaError?error.status:500},error instanceof ArenaError?error.status:500);}
}

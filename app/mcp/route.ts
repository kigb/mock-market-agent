import {MCP_TOOLS} from '../../lib/arena/protocol';
import {callTool} from '../../lib/arena/service';
import {ArenaError} from '../../lib/arena/engine';
export const dynamic='force-dynamic';
const json=(data:unknown,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store'}});
export async function GET(){return new Response(null,{status:405,headers:{Allow:'POST'}});}
export async function POST(request:Request){
 const origin=request.headers.get('Origin');if(origin&&origin!==new URL(request.url).origin)return json({error:'Invalid Origin'},403);
 let message:any;try{const text=await request.text();if(text.length>64000)return json({jsonrpc:'2.0',id:null,error:{code:-32600,message:'Request too large'}},413);message=JSON.parse(text);}catch{return json({jsonrpc:'2.0',id:null,error:{code:-32700,message:'Parse error'}},400);}
 const id=message?.id??null,error=(code:number,text:string)=>json({jsonrpc:'2.0',id,error:{code,message:text}});
 if(!message||Array.isArray(message)||message.jsonrpc!=='2.0'||typeof message.method!=='string')return error(-32600,'Invalid Request');
 if(message.method.startsWith('notifications/'))return new Response(null,{status:202});
 const ok=(result:unknown)=>json({jsonrpc:'2.0',id,result});
 if(message.method==='server/discover')return ok({supportedVersions:['2026-07-28','2025-06-18'],capabilities:{tools:{}}});
 if(message.method==='initialize')return ok({protocolVersion:message.params?.protocolVersion==='2026-07-28'?'2026-07-28':'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'Market Arena',version:'2.0.0'},instructions:'A timed agent trading arena (180 seconds by default, 30–600 via create_game durationSeconds). Read get_rules, create_game, register agents, start_game, then trade MOCK. Use a separate agent token per contestant.'});
 if(message.method==='ping')return ok({});
 if(message.method==='tools/list')return ok({tools:MCP_TOOLS});
 if(message.method==='tools/call'){
  const name=message.params?.name,args=message.params?.arguments??{};
  if(typeof name!=='string'||!args||typeof args!=='object'||Array.isArray(args))return error(-32602,'Invalid tool arguments');
  try{const result=await callTool(name,args,request.headers.get('oai-authenticated-user-id')||'');return ok({content:[{type:'text',text:JSON.stringify(result)}],structuredContent:result,isError:false});}
  catch(e){return ok({content:[{type:'text',text:e instanceof ArenaError?e.message:'Arena tool failed. Please retry.'}],isError:true});}
 }
 return error(-32601,'Method not found');
}

import {ArenaError,type Intent,type Agent, type Game,observation,orderBook} from './engine.ts';
import {normalizeCompletion,type ChatMessage} from './conversation.ts';
import {MODEL_TOOLS,SYSTEM_PROMPT} from './protocol.ts';
export type ModelConfig={provider:'modal'|'sail'|'fireworks';model:string;apiKey:string;baseUrl?:string;temperature?:number;maxTokens?:number;prompt?:string;reasoningEffort?:'none'|'low';};
export function endpoint(config:ModelConfig){
 if(!['modal','sail','fireworks'].includes(config.provider))throw new ArenaError('Choose Modal, Sail Research, or Fireworks.');
 if(typeof config.apiKey!=='string'||config.apiKey.length>2048||/[\r\n]/.test(config.apiKey))throw new ArenaError('Invalid API key.');
 if(config.provider!=='modal'&&!config.apiKey.trim())throw new ArenaError('Enter your provider API key.');
 if(typeof config.model!=='string'||!config.model.trim()||config.model.length>200)throw new ArenaError('Enter the exact model ID from your provider.');
 let base=config.provider==='fireworks'?'https://api.fireworks.ai/inference/v1':config.provider==='sail'?'https://api.sailresearch.com/v1':config.baseUrl;
 if(!base)throw new ArenaError('Enter the deployed Modal base URL, including /v1.');
 let url:URL;try{url=new URL(base);}catch{throw new ArenaError('Enter a valid HTTPS base URL.');}
 if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.port)throw new ArenaError('Use a plain HTTPS base URL without credentials, query, or port.');
 if(config.provider==='modal'&&!/\.(modal\.run|modal\.direct)$/.test(url.hostname))throw new ArenaError('Use your deployed *.modal.run or *.modal.direct endpoint.');
 base=url.href.replace(/\/$/,'').replace(/\/chat\/completions$/,'');
 return base+'/chat/completions';
}
export function parseDecision(data:any):Intent[]{
 const message=data?.choices?.[0]?.message;if(!message)throw new ArenaError('The provider returned no completion message.');
 if(Array.isArray(message.tool_calls)&&message.tool_calls.length){return message.tool_calls.slice(0,4).map((c:any)=>{let args;try{args=JSON.parse(c.function?.arguments||'{}');}catch{throw new ArenaError('The model returned invalid tool arguments.');}return {...args,action:c.function?.name};});}
 if(typeof message.content==='string'&&message.content.trim()){
  let raw=message.content.trim().replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,'');
  try{const p=JSON.parse(raw),list=Array.isArray(p)?p:Array.isArray(p.actions)?p.actions:[p];return list.slice(0,4).map((i:any)=>({...i,action:i.action||i.name}));}catch{throw new ArenaError('The model returned text instead of trading tool calls or a JSON action. Choose a tool-capable model.');}
 }
 throw new ArenaError('The model produced no trading decision (possibly exhausted its token budget).');
}
async function requestCompletion(config:ModelConfig,messages:ChatMessage[],timeoutMs:number,fetcher:typeof fetch=fetch){
 const url=endpoint(config),temperature=config.temperature??0.3,maxTokens=config.maxTokens??512;
 if(!Number.isFinite(temperature)||temperature<0||temperature>2)throw new ArenaError('Temperature must be 0–2.');
 if(!Number.isInteger(maxTokens)||maxTokens<64||maxTokens>4096)throw new ArenaError('Max output tokens must be 64–4096.');
 if(config.prompt&&config.prompt.length>4000)throw new ArenaError('Strategy prompt must be at most 4,000 characters.');
 const started=Date.now();let response:Response;
 try{response=await fetcher(url,{method:'POST',redirect:'manual',headers:{'Content-Type':'application/json',...(config.apiKey.trim()?{Authorization:'Bearer '+config.apiKey.trim()}:{})},body:JSON.stringify({model:config.model.trim(),messages:[{role:'system',content:SYSTEM_PROMPT+(config.prompt?'\nYour strategy: '+config.prompt:'')},...messages],tools:MODEL_TOOLS,tool_choice:'auto',parallel_tool_calls:true,temperature,...(config.provider==='sail'?{max_completion_tokens:maxTokens,metadata:{completion_window:'asap'},...(config.reasoningEffort?{reasoning_effort:config.reasoningEffort}:{})}:{max_tokens:maxTokens}),stream:false}),signal:AbortSignal.timeout(Math.max(100,Math.min(12000,timeoutMs)))});}catch(error){
  const detail=error instanceof Error?(config.apiKey?error.message.replaceAll(config.apiKey,'[redacted]'):error.message).slice(0,300):'Unknown transport error';
  console.error('Provider transport failure',{provider:config.provider,name:error instanceof Error?error.name:'Unknown',detail});
  throw new ArenaError(error instanceof Error&&/abort|timeout/i.test(error.name+' '+error.message)?'Provider timed out. The game clock keeps running.':'Could not reach the provider. Check the endpoint and its deployment.',502);}
 if(!response.ok&&response.status===400){const detail=await response.text();if(/context_length_exceeded|exceeds.*context|exceeds safe limit|maximum context/i.test(detail))throw new ArenaError('Provider context window exceeded. The full conversation is retained; choose a model with a larger context window.',502);}
 if(!response.ok)throw new ArenaError(`Provider HTTP ${response.status}. ${response.status===401||response.status===403?'Check the API key and model permissions.':response.status===429?'Provider rate limit or quota reached.':'Check the model ID, endpoint, and tool-calling support.'}`,502);
 const text=await response.text();if(text.length>256000)throw new ArenaError('Provider response is too large.',502);
 let data:any;try{data=JSON.parse(text);}catch{throw new ArenaError('The provider did not return JSON.',502);}
 return {data,latencyMs:Date.now()-started,usage:{promptTokens:Number(data.usage?.prompt_tokens)||0,completionTokens:Number(data.usage?.completion_tokens)||0}};
}
export async function complete(config:ModelConfig,messages:ChatMessage[],timeoutMs:number,fetcher:typeof fetch=fetch){const {data,...meta}=await requestCompletion(config,messages,timeoutMs,fetcher);return {...normalizeCompletion(data),...meta};}
export async function infer(config:ModelConfig,observed:unknown,timeoutMs:number,fetcher:typeof fetch=fetch){const {data,...meta}=await requestCompletion(config,[{role:'user',content:JSON.stringify(observed)}],timeoutMs,fetcher);return {actions:parseDecision(data),...meta};}
export function baseline(g:Game,a:Agent):Intent[]{
 const book=orderBook(g),quote=(side:'buy'|'sell',p:number,q=5):Intent=>({action:'place_order',type:'limit',side,quantity:q,price:Math.round(Math.max(0,Math.min(100,p))*100)/100});
 // An individual starter strategy chooses its own opening quote; the exchange supplies none.
 const hash=[...a.id].reduce((v,c)=>(Math.imul(v,31)+c.charCodeAt(0))>>>0,17);
 const ownOpening=(hash%10001)/100;
 const reference=g.lastPrice!==null?g.lastPrice/100:book.bestBid!==null&&book.bestAsk!==null?(book.bestBid+book.bestAsk)/2:book.bestBid??book.bestAsk??ownOpening;
 const actions:Intent[]=[{action:'cancel_all'}];
 if(a.strategy==='maker'){
  const skew=Math.max(-.15,Math.min(.15,a.position*.002));return [...actions,quote('buy',reference-.04-skew),quote('sell',reference+.04-skew)];
 }
 if(a.strategy==='mean_reversion'){
  const recent=g.fills.slice(-10),qty=recent.reduce((q,f)=>q+f.quantity,0),anchor=qty?recent.reduce((s,f)=>s+f.price*f.quantity,0)/qty/100:reference;
  if(book.bestAsk!==null&&book.bestAsk<anchor)return [...actions,{action:'place_order',side:'buy',type:'market',quantity:3}];
  if(book.bestBid!==null&&book.bestBid>anchor)return [...actions,{action:'place_order',side:'sell',type:'market',quantity:3}];
  return [...actions,quote('buy',anchor-.02,3),quote('sell',anchor+.02,3)];
 }
 const fills=g.fills.slice(-2),up=fills.length===2?fills[1].price>=fills[0].price:(Math.floor((g.botAt-g.startedAt!)/10000)%2===0);
 if((up&&book.bestAsk!==null)||(!up&&book.bestBid!==null))return [...actions,{action:'place_order',side:up?'buy':'sell',type:'market',quantity:2}];
 return [...actions,quote('buy',reference-.05,3),quote('sell',reference+.05,3)];
}

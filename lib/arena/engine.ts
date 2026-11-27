import {LIMIT_BAND_CENTS, OFFSET_DEGREES_OF_FREEDOM, OFFSET_SCALE_CENTS, studentTOffset} from './atlas-offset.ts';
import {BOT_MODES,DEFAULT_BOT_MODE,modeConfig,type BotMode} from './modes.ts';
import {defaultAgent} from './presets.ts';
import {sha256,sha256Hex,bytesFromHex,randomHex} from './sha256.ts';
export const TICKER = 'MOCK';
// Hidden-center default; modeConfig supplies the market-relative default. Each round persists durationMs.
export const DURATION = 180_000;
export const MIN_DURATION = 30_000;
export const MAX_DURATION = 600_000;
export function durationOf(g:{durationMs?:number}){return g.durationMs??60_000;}
// Per-agent call budget scales with the round: 120 calls per minute of play.
export function callLimit(g:{durationMs?:number}){return Math.ceil(durationOf(g)/60_000)*120;}
// Server floor between decision starts for free-running agents (intervalMs 0): a model decides again as soon as its previous
// decision lands, but never more than four times a second.
export const MIN_DECISION_GAP_MS=250;
export const BOT_INTERVAL_MS = 10_000;
// Schema 6 Atlas: Poisson arrivals, limit IOC within ±band of a hidden per-game center.
export const ATLAS_MEAN_INTERVAL_MS = 2_000;
export const ATLAS_CENTER_RANGE_CENTS = [2000, 8000] as const;
export const ATLAS_LIMIT_BAND_CENTS = LIMIT_BAND_CENTS;
const ATLAS_MAX_ARRIVALS = 300;
// Schema 7 cap: three times the expected arrival count plus 50, so the plan is never truncated in practice.
export function atlasArrivalCap(durationMs:number){return Math.ceil(durationMs/ATLAS_MEAN_INTERVAL_MS)*3+50;}
const LEGACY_SETTLEMENT_CENTS = 5000;
export type Side = 'buy' | 'sell';
export type AgentSpec = {preset?:string;name:string;provider:'baseline'|'modal'|'sail'|'fireworks'|'external';model?:string;strategy?:'maker'|'mean_reversion'|'momentum';intervalMs?:number};
export type Agent = AgentSpec & {id:string;token:string;cash:number;position:number;average:number;realized:number;orders:number;submittedQuantity:number;filledQuantity:number;fills:number;makerFills:number;takerFills:number;cancellations:number;expired:number;peakPosition:number;peakPnl:number;maxDrawdown:number;calls:number;historyMessages?:number;errors:number;latencyMs:number;latencySamples:number;promptTokens:number;completionTokens:number;lastDecision:number;leaseUntil:number;leaseId:string;requestWindow:number;requestCount:number};
export type Order = {id:string;agentId:string;side:Side;price:number;quantity:number;originalQuantity:number;sequence:number;time:number};
export type BotSelection = 'best'|'worst';
export type AtlasArrival = {time:number;side:Side;quantity:number;limit:number;distance?:number};
export type BotTick = {time:number;side:Side;selection:BotSelection;limitPrice?:number;referenceMid?:number;distance?:number;bestBid?:number|null;bestAsk?:number|null;skipReason?:'one_sided'|'wide_spread'|'no_executable_liquidity';requestedQuantity:number;filledQuantity:number;canceledQuantity:number;averageFillPrice:number|null;bestAvailablePrice:number|null;worstAvailablePrice:number|null;executions:{price:number;quantity:number;maker:string}[]};
export type Fill = {id:number;time:number;price:number;quantity:number;side:Side;maker:string;taker:string;botSelection?:BotSelection};
export type Event = {id:number;time:number;agentId:string;type:'order'|'fill'|'cancel'|'decision'|'error'|'system';message:string};
export type Intent = {action:'place_order'|'cancel_order'|'cancel_all'|'replace_order'|'wait'|'get_rules'|'get_order_book'|'get_position'|'get_atlas_history'|'get_fills';side?:Side;type?:'limit'|'market';quantity?:number;price?:number;orderId?:string;reason?:string;limit?:number;timeInForce?:'GTC'|'IOC';postOnly?:boolean};
export type Valuation={price:number|null;source:'midpoint'|'last_trade'|'unpriced'|'legacy_fixed'|'realized_only'|'atlas_center'|'window_vwap'|'full_round_vwap';bestBid:number|null;bestAsk:number|null};
export type Game = {schema:2|3|4|5|6|7|8|9;botMode?:BotMode;tradeNotional?:number;tradeQuantity?:number;settlementTrades?:{time:number;price:number;quantity:number;event:string}[];settlement?:{source:string;price:number|null;quality:'low'|'normal'|'no_trades';windowVolume:number;windowEvents:number;fullRoundVwap:number|null;windowVwap:number|null;closingMidpoint:number|null;accounts:{agentId:string;cashBefore:number;positionBefore:number;cashAfter:number;positionAfter:number}[]};id:string;hostToken:string;owner:string;createdAt:number;status:'lobby'|'running'|'finished';startedAt:number|null;endsAt:number|null;finishedAt:number|null;seed:number;durationMs?:number;rng:number;sequence:number;botAt:number;botAttempts:number;botTicks?:BotTick[];atlasNonce?:number;atlasSecret?:string;atlasCommitment?:string;atlasCenter?:number;atlasPlan?:AtlasArrival[];agents:Agent[];orders:Order[];fills:Fill[];events:Event[];receipts:{agentId:string;id:string;result:unknown;signature?:string}[];series:{time:number;price:number;volume:number}[];lastPrice:number|null;firstPrice?:number|null;volume:number;finalBook:ReturnType<typeof orderBook>|null;closingValuation?:Valuation};
export class ArenaError extends Error {status:number;constructor(message:string,status=400){super(message);this.name='ArenaError';this.status=status;}}
export function random(g:Game){g.rng=(Math.imul(g.rng,1664525)+1013904223)>>>0;return g.rng/4294967296;}
export function cents(value:unknown){if(typeof value!=='number'||!Number.isFinite(value)||value<0||value>100||Math.abs(value*100-Math.round(value*100))>0.000001)throw new ArenaError('Price must be between 0 and 100, in 0.01 ticks.');return Math.round(value*100);}
export function newAgent(spec:AgentSpec,id:string,token:string):Agent {
  if(!spec||typeof spec!=='object')throw new ArenaError('Invalid agent configuration.');
  const preset=spec.preset===undefined?undefined:defaultAgent(spec.preset);
  if(spec.preset!==undefined&&!preset)throw new ArenaError('Unknown arena-provided agent.');
  if(preset&&(spec.provider!==preset.provider||spec.model!==preset.model||(spec.intervalMs!==undefined&&spec.intervalMs!==preset.intervalMs)))throw new ArenaError('Arena-provided models and decision intervals are fixed. Add your own agent to customize a model.');
  if(preset)spec={...spec,...preset,name:spec.name};
  if(spec.model!==undefined&&typeof spec.model!=='string')throw new ArenaError('Model ID must be a string.');
  if(typeof spec.name!=='string'||!spec.name.trim()||spec.name.trim().length>32)throw new ArenaError('Agent names must be 1–32 characters.');
  if(!['baseline','modal','sail','fireworks','external'].includes(spec.provider))throw new ArenaError('Unknown agent provider.');
  // Model agents default to free-running (0): the next decision starts as soon as the previous one completes. Rule strategies keep a 2 s cadence.
  const intervalMs=spec.intervalMs??(spec.provider==='baseline'?2000:0);
  if(!Number.isInteger(intervalMs)||intervalMs<0||intervalMs>10000)throw new ArenaError('Decision interval must be 0–10,000 ms (0 = as soon as the previous decision completes).');
  if(spec.provider==='baseline'&&!['maker','mean_reversion','momentum'].includes(spec.strategy||''))throw new ArenaError('Choose a baseline strategy.');
  if(!['baseline','external'].includes(spec.provider)&&(typeof spec.model!=='string'||!spec.model.trim()||spec.model.length>200))throw new ArenaError('Enter the provider’s model ID.');
  return {preset:spec.preset,name:spec.name.trim(),provider:spec.provider,model:spec.model?.slice(0,200),strategy:spec.strategy,intervalMs,id,token,cash:0,position:0,average:0,realized:0,orders:0,submittedQuantity:0,filledQuantity:0,fills:0,makerFills:0,takerFills:0,cancellations:0,expired:0,peakPosition:0,peakPnl:0,maxDrawdown:0,calls:0,errors:0,latencyMs:0,latencySamples:0,promptTokens:0,completionTokens:0,lastDecision:0,leaseUntil:0,leaseId:'',requestWindow:0,requestCount:0};
}
export function addEvent(g:Game,time:number,agentId:string,type:Event['type'],message:string){g.events.push({id:++g.sequence,time,agentId,type,message:message.slice(0,250)});g.events=g.events.slice(-400);}
// Commit-reveal: a 256-bit secret is drawn at creation and only its SHA-256 commitment is public until the close.
// A public (often default) seed therefore cannot reveal the center, and the revealed secret lets anyone replay the plan.
export function atlasCommitment(secretHex:string){return sha256Hex(bytesFromHex(secretHex));}
export function createGame(id:string,hostToken:string,owner:string,specs:AgentSpec[],now:number,seed=42,atlasSecret=randomHex(32),durationMs:number|undefined=undefined,botMode:BotMode=DEFAULT_BOT_MODE):Game {
  const config=modeConfig(botMode);if(!config)throw new ArenaError('Unknown bot mode. Choose market_relative or hidden_center.');
  durationMs??=config.defaultDurationSeconds*1000;
  if(!Array.isArray(specs)||specs.length>8)throw new ArenaError('Use up to eight competing agents.');
  if(!Number.isInteger(seed)||seed<0||seed>2147483647)throw new ArenaError('Seed must be an integer from 0 to 2147483647.');
  if(typeof atlasSecret!=='string'||!/^[0-9a-f]{64}$/.test(atlasSecret))throw new ArenaError('The Atlas secret must be 32 random bytes in lowercase hex.');
  if(!Number.isInteger(durationMs)||durationMs%1000||durationMs<MIN_DURATION||durationMs>MAX_DURATION)throw new ArenaError(`Round length must be a whole number of seconds from ${MIN_DURATION/1000} to ${MAX_DURATION/1000}.`);
  const g:Game={schema:botMode==='market_relative'?8:9,botMode,id,hostToken,owner,createdAt:now,status:'lobby',startedAt:null,endsAt:null,finishedAt:null,seed,durationMs,rng:seed,sequence:0,botAt:0,botAttempts:0,botTicks:[],atlasSecret,atlasCommitment:atlasCommitment(atlasSecret),agents:[],orders:[],fills:[],events:[],receipts:[],series:[],lastPrice:null,firstPrice:null,volume:0,finalBook:null};
  for(const spec of specs)addAgent(g,spec,crypto.randomUUID(),crypto.randomUUID(),now);
  g.agents.push(newAgent({name:'Atlas',provider:'external'},'$atlas',''));
  addEvent(g,now,'$system','system',`Lobby created. ${config.name} mode. One ticker. ${durationMs/1000} seconds.`);return g;
}
export function addAgent(g:Game,spec:AgentSpec,id:string,token:string,now:number){if(g.status!=='lobby')throw new ArenaError('Agents must register before the game starts.',409);if(g.agents.filter(a=>a.id!=='$atlas').length>=8)throw new ArenaError('This arena is full (8 agents).',409);if(typeof spec?.name!=='string')throw new ArenaError('Enter an agent name.');if(spec.name.trim().toLowerCase()==='atlas')throw new ArenaError('Atlas is reserved for the system bot.');if(g.agents.some(a=>a.name.toLowerCase()===spec.name.trim().toLowerCase()))throw new ArenaError('Use a unique agent name.');if(spec.preset&&g.agents.some(a=>a.preset===spec.preset))throw new ArenaError('Each arena-provided agent can appear only once per game.');const a=newAgent(spec,id,token);g.agents.push(a);addEvent(g,now,a.id,'system',`${a.name} joined the arena.`);return a;}
export function startGame(g:Game,now:number){if(g.status!=='lobby')throw new ArenaError('This game has already started.',409);if(g.agents.length<2)throw new ArenaError('Register at least one competing agent before starting.');g.status='running';g.startedAt=now;g.endsAt=now+durationOf(g);g.botAt=now;if(g.schema>=6)planAtlas(g);addEvent(g,now,'$system','system',`Game started. Orders close in ${durationOf(g)/1000} seconds.`);}
// Schema 7 randomness: uniform values come from SHA-256(secret || seed as uint32 BE || counter as uint32 BE) digests,
// consumed as eight big-endian uint32 words per counter, each divided by 2^32. Observed arrivals cannot be inverted
// to recover the secret or the center, and the revealed secret reproduces the plan exactly.
export function atlasStream(secretHex:string,seed:number){
 const secret=bytesFromHex(secretHex),message=new Uint8Array(secret.length+8),view=new DataView(message.buffer);message.set(secret);view.setUint32(secret.length,seed>>>0);
 let counter=0,words:number[]=[];
 return ()=>{if(!words.length){view.setUint32(secret.length+4,counter++);const digest=new DataView(sha256(message).buffer);words=Array.from({length:8},(_,i)=>digest.getUint32(i*4));}return words.shift()!/4294967296;};
}
// Draw order is fixed: the center first, then per arrival the exponential gap, side, quantity, and limit offset.
type HiddenCenterVersion = 'hidden-center-v1' | 'hidden-center-v2';
function drawAtlasPlan(next:()=>number,startedAt:number,endsAt:number,cap=ATLAS_MAX_ARRIVALS,version:HiddenCenterVersion='hidden-center-v1'){
 const [low,high]=ATLAS_CENTER_RANGE_CENTS,center=low+Math.floor(next()*(high-low+1)),plan:AtlasArrival[]=[];
 for(let t=startedAt;plan.length<cap;){t+=Math.max(1,Math.round(-Math.log(1-next())*ATLAS_MEAN_INTERVAL_MS));if(t>=endsAt)break;plan.push({time:t,side:next()<.5?'buy':'sell',quantity:1+Math.floor(next()*5),limit:center+(version==='hidden-center-v2'?studentTOffset(next()):Math.round((next()*2-1)*ATLAS_LIMIT_BAND_CENTS))});}
 return {center,plan};
}
// Anyone holding the revealed secret can recompute the center and every arrival and compare them with atlas.ticks.
// The original four-argument API replays uniform v1 archives. New callers pass the published rulesVersion.
export function replayAtlas(seed:number,secretHex:string,startedAt:number,endsAt:number,version:HiddenCenterVersion='hidden-center-v1'){
 return drawAtlasPlan(atlasStream(secretHex,seed),startedAt,endsAt,atlasArrivalCap(endsAt-startedAt),version);
}
export function isRelative(g:Game){return g.schema===8&&g.botMode==='market_relative';}
export function botModeOf(g:Game){return isRelative(g)?'market_relative' as const:g.schema>=6?'hidden_center' as const:g.schema===5?'legacy_best_worst' as const:'legacy_best' as const;}
export function replayRelativeAtlas(seed:number,secretHex:string,startedAt:number,endsAt:number){
 const channel=(name:string)=>atlasStream(sha256Hex(new Uint8Array([...bytesFromHex(secretHex),...new TextEncoder().encode('market_relative:'+name)])),seed);
 const gap=channel('arrivals'),side=channel('sides'),size=channel('sizes'),distance=channel('tolerances'),plan:AtlasArrival[]=[];
 const cap=Math.ceil((endsAt-startedAt)/1000)*3+50;
 for(let t=startedAt;plan.length<cap;){t+=Math.max(1,Math.round(-Math.log(1-gap())*1000));if(t>=endsAt)break;plan.push({time:t,side:side()<.5?'buy':'sell',quantity:1+Math.floor(size()*5),distance:1+Math.floor(distance()*50),limit:0});}
 return {plan};
}
export function riskCapacity(g:Game,a:Agent,orders=g.orders){
 const reservedBuy=orders.filter(o=>o.agentId===a.id&&o.side==='buy').reduce((n,o)=>n+o.quantity,0),reservedSell=orders.filter(o=>o.agentId===a.id&&o.side==='sell').reduce((n,o)=>n+o.quantity,0);
 return {maxPosition:isRelative(g)?20:null,reservedBuy,reservedSell,buyCapacity:isRelative(g)?20-a.position-reservedBuy:null,sellCapacity:isRelative(g)?20+a.position-reservedSell:null};
}
function vwapClose(g:Game):Valuation{
 const window=(g.settlementTrades??[]).filter(t=>t.time>=g.endsAt!-10000&&t.time<g.endsAt!),volume=window.reduce((n,t)=>n+t.quantity,0),events=new Set(window.map(t=>t.event)).size;
 const full=g.tradeQuantity?g.tradeNotional!/g.tradeQuantity:null,win=volume?window.reduce((n,t)=>n+t.price*t.quantity,0)/volume:null;
 const book=marketValuation(g),price=win??full,source=win!==null?'window_vwap':full!==null?'full_round_vwap':'unpriced';
 g.settlement={source,price:price===null?null:price/100,quality:price===null?'no_trades':volume>=10&&events>=3?'normal':'low',windowVolume:volume,windowEvents:events,fullRoundVwap:full===null?null:full/100,windowVwap:win===null?null:win/100,closingMidpoint:book.bestBid!==null&&book.bestAsk!==null?(book.bestBid+book.bestAsk)/200:null,accounts:g.agents.map(a=>({agentId:a.id,cashBefore:a.cash/100,positionBefore:a.position,cashAfter:(a.cash+a.position*(price??0))/100,positionAfter:0}))};
 if(price===null&&g.agents.some(a=>a.position!==0))throw new ArenaError('Ledger error: inventory exists without any trades.',500);
 return {...book,price,source};
}
function planAtlas(g:Game){
 if(isRelative(g)){g.atlasPlan=replayRelativeAtlas(g.seed,g.atlasSecret!,g.startedAt!,g.endsAt!).plan;return;}
 let drawn;
 if(g.schema>=7){if(!g.atlasSecret)throw new ArenaError('This game has no Atlas secret.');drawn=replayAtlas(g.seed,g.atlasSecret,g.startedAt!,g.endsAt!,g.schema===9?'hidden-center-v2':'hidden-center-v1');}
 else{
  // Historical schema 6: a separate LCG stream from g.rng, seeded by the public seed and a secret 32-bit nonce.
  let s=(Math.imul(g.seed^0x5bd1e995,2654435761)^(g.atlasNonce??0))>>>0;const next=()=>{s=(Math.imul(s,1664525)+1013904223)>>>0;return s/4294967296;};for(let i=0;i<8;i++)next();
  drawn=drawAtlasPlan(next,g.startedAt!,g.endsAt!);
 }
 g.atlasCenter=drawn.center;g.atlasPlan=drawn.plan;
}
export function sorted(g:Game,side:Side){return g.orders.filter(o=>o.side===side).sort((a,b)=>(side==='buy'?b.price-a.price:a.price-b.price)||a.sequence-b.sequence);}
export function orderBook(g:Game){
 const levels=(side:Side)=>{const rows=new Map<number,{price:number;quantity:number;orders:number}>();for(const o of sorted(g,side)){const r=rows.get(o.price)||{price:o.price/100,quantity:0,orders:0};r.quantity+=o.quantity;r.orders++;rows.set(o.price,r);}return [...rows.values()];};
 const bids=levels('buy'),asks=levels('sell');return {ticker:TICKER,bids,asks,bestBid:bids[0]?.price??null,bestAsk:asks[0]?.price??null,spread:bids.length&&asks.length?Math.round((asks[0].price-bids[0].price)*100)/100:null};
}
export function pnl(a:Agent,legacy=false,mark?:number|null){return mark!=null?a.cash+a.position*mark:legacy?a.cash+a.position*LEGACY_SETTLEMENT_CENTS:a.realized;}
function marketValuation(g:Game):Valuation{
 const bestBid=sorted(g,'buy')[0]?.price??null,bestAsk=sorted(g,'sell')[0]?.price??null;
 return {price:bestBid!==null&&bestAsk!==null?(bestBid+bestAsk)/2:g.lastPrice,source:bestBid!==null&&bestAsk!==null?'midpoint':g.lastPrice!==null?'last_trade':'unpriced',bestBid,bestAsk};
}
export function valuation(g:Game):Valuation{
 if(g.schema===2)return {price:LEGACY_SETTLEMENT_CENTS,source:'legacy_fixed',bestBid:null,bestAsk:null};
 if(g.schema===3)return {price:null,source:'realized_only',bestBid:null,bestAsk:null};
 return g.status==='finished'&&g.closingValuation?g.closingValuation:marketValuation(g);
}
function revalue(g:Game){if(g.schema<4)return;const mark=valuation(g).price;for(const a of g.agents){const score=pnl(a,false,mark);a.peakPnl=Math.max(a.peakPnl,score);a.maxDrawdown=Math.max(a.maxDrawdown,a.peakPnl-score);}}
function publicValuation(g:Game){const v=valuation(g);return {...v,price:v.price===null?null:v.price/100,bestBid:v.bestBid===null?null:v.bestBid/100,bestAsk:v.bestAsk===null?null:v.bestAsk/100,frozen:g.status==='finished'};}
function account(a:Agent,side:Side,qty:number,price:number,maker:boolean,legacy=false,market=false){const change=side==='buy'?qty:-qty,old=a.position;
 if(!old||Math.sign(old)===Math.sign(change))a.average=(a.average*Math.abs(old)+price*qty)/(Math.abs(old)+qty);
 else{a.realized+=Math.min(Math.abs(old),qty)*(price-a.average)*Math.sign(old);if(qty>Math.abs(old))a.average=price;if(qty===Math.abs(old))a.average=0;}
 a.position+=change;a.cash-=change*price;a.filledQuantity+=qty;a.fills++;if(maker)a.makerFills++;else a.takerFills++;
 a.peakPosition=Math.max(a.peakPosition,Math.abs(a.position));if(!market){a.peakPnl=Math.max(a.peakPnl,pnl(a,legacy));a.maxDrawdown=Math.max(a.maxDrawdown,a.peakPnl-pnl(a,legacy));}
}
export function match(g:Game,a:Agent,side:Side,type:'limit'|'market',quantity:number,price:number|null,now:number,selection:BotSelection='best'){
 if(selection!=='best'&&selection!=='worst')throw new ArenaError('Unknown execution selection.');
 if(selection==='worst'&&(a.id!=='$atlas'||g.schema!==5||type!=='market'||price!==null))throw new ArenaError('Only Atlas may use worst-first execution.');
 if(a.id==='$atlas'&&g.schema>=5&&(!Number.isInteger(quantity)||quantity<1||quantity>5))throw new ArenaError('Atlas quantity must be 1–5 contracts per attempt.');
 let remaining=quantity,notional=0,filled=0;const id='ord_'+(++g.sequence);
 a.orders++;a.submittedQuantity+=quantity;
 const priority=sorted(g,side==='buy'?'sell':'buy');
 if(selection==='worst')priority.sort((x,y)=>(side==='buy'?y.price-x.price:x.price-y.price)||x.sequence-y.sequence);
 for(const resting of priority){
  if(!remaining)break;if(price!==null&&(side==='buy'?resting.price>price:resting.price<price))break;
  if(resting.agentId===a.id){g.orders=g.orders.filter(o=>o.id!==resting.id);a.cancellations++;addEvent(g,now,a.id,'cancel',`Self-match prevention canceled ${resting.id}.`);continue;}
  const qty=Math.min(remaining,resting.quantity),maker=g.agents.find(x=>x.id===resting.agentId)!;
  resting.quantity-=qty;remaining-=qty;filled+=qty;notional+=qty*resting.price;
  account(a,side,qty,resting.price,false,g.schema===2,g.schema>=4);account(maker,side==='buy'?'sell':'buy',qty,resting.price,true,g.schema===2,g.schema>=4);
  const f:Fill={id:++g.sequence,time:now,price:resting.price,quantity:qty,side,maker:maker.id,taker:a.id,...(a.id==='$atlas'&&g.schema===5?{botSelection:selection}:{})};g.fills.push(f);if(isRelative(g)){g.tradeNotional=(g.tradeNotional??0)+f.price*qty;g.tradeQuantity=(g.tradeQuantity??0)+qty;(g.settlementTrades??=[]).push({time:now,price:f.price,quantity:qty,event:id});g.settlementTrades=g.settlementTrades.filter(t=>t.time>=now-10000);}g.lastPrice=f.price;if(g.firstPrice==null)g.firstPrice=f.price;g.volume+=qty;g.series.push({time:now,price:f.price/100,volume:g.volume});
  addEvent(g,now,a.id,'fill',`${a.name}${a.id==='$atlas'&&g.schema===5?' ['+selection+' price]':''} ${side==='buy'?'bought':'sold'} ${qty} @ ${(f.price/100).toFixed(2)} from ${maker.name}.`);
 }
 g.orders=g.orders.filter(o=>o.quantity>0);
 if(remaining&&type==='limit')g.orders.push({id,agentId:a.id,side,price:price!,quantity:remaining,originalQuantity:quantity,sequence:g.sequence,time:now});
 g.fills=g.fills.slice(-1200);
 g.series=g.series.slice(-500);revalue(g);
 return {orderId:id,filledQuantity:filled,remainingQuantity:type==='limit'?remaining:0,canceledQuantity:type==='market'?remaining:0,averageFillPrice:filled?notional/filled/100:null,status:remaining?(type==='limit'?(filled?'partially_filled':'open'):(filled?'partially_filled':'unfilled')):'filled'};
}
// Limit IOC at normal price priority. No summary event: the limit and unfilled size stay hidden until the close.
function arriveAtlas(g:Game,until:number){
 const a=g.agents.find(a=>a.id==='$atlas')!;
 for(const arrival of g.atlasPlan!.slice(g.botAttempts)){
  if(arrival.time>until||isRelative(g)&&arrival.time>=g.endsAt!)break;g.botAttempts++;g.botAt=arrival.time;
  const available=sorted(g,arrival.side==='buy'?'sell':'buy'),priorFill=g.fills.at(-1)?.id??0;
  const book=orderBook(g),relative=isRelative(g),mid=book.bestBid!==null&&book.bestAsk!==null?(Math.round(book.bestBid*100)+Math.round(book.bestAsk*100))/2:null;
  const skip=relative?(mid===null?'one_sided':book.spread!>1?'wide_spread':undefined):undefined;
  const price=relative?(mid===null?null:arrival.side==='buy'?Math.floor(Math.min(10000,mid+arrival.distance!)):Math.ceil(Math.max(0,mid-arrival.distance!))):arrival.limit;
  const result=skip?{filledQuantity:0,canceledQuantity:arrival.quantity,averageFillPrice:null}:match(g,a,arrival.side,'market',arrival.quantity,price,arrival.time);
  g.botTicks!.push({time:arrival.time,side:arrival.side,selection:'best',...(price!==null?{limitPrice:price/100}:{}),...(relative?{referenceMid:mid===null?undefined:mid/100,distance:arrival.distance!/100,bestBid:book.bestBid,bestAsk:book.bestAsk,skipReason:skip??(!result.filledQuantity?'no_executable_liquidity':undefined)}:{}),requestedQuantity:arrival.quantity,filledQuantity:result.filledQuantity,canceledQuantity:result.canceledQuantity,averageFillPrice:result.averageFillPrice,bestAvailablePrice:available.length?available[0].price/100:null,worstAvailablePrice:available.length?available.at(-1)!.price/100:null,executions:g.fills.filter(f=>f.id>priorFill).map(f=>({price:f.price/100,quantity:f.quantity,maker:f.maker}))});
 }
}
export function ensureRunning(g:Game,now:number){if(g.status!=='running'||now>=g.endsAt!)throw new ArenaError(g.status==='lobby'?'Start the game before submitting orders.':'The game has ended. Late orders are rejected.',409);}
export function advance(g:Game,now:number){if(g.status!=='running')return;const until=Math.min(now,g.endsAt!);if(g.schema>=6)arriveAtlas(g,until);else{const interval=g.schema===2?1000:BOT_INTERVAL_MS;while(g.botAt+interval<=until){g.botAt+=interval;g.botAttempts++;const a=g.agents.find(a=>a.id==='$atlas')!,side=random(g)>.5?'buy':'sell',qty=1+Math.floor(random(g)*5),selection:BotSelection=g.schema>=5&&random(g)>=.5?'worst':'best';const available=sorted(g,side==='buy'?'sell':'buy'),bestAvailablePrice=available.length?available[0].price/100:null,worstAvailablePrice=available.length?available.at(-1)!.price/100:null,priorFill=g.fills.at(-1)?.id??0;const result=match(g,a,side,'market',qty,null,g.botAt,selection);if(g.schema>=5){(g.botTicks??=[]).push({time:g.botAt,side,selection,requestedQuantity:qty,filledQuantity:result.filledQuantity,canceledQuantity:result.canceledQuantity,averageFillPrice:result.averageFillPrice,bestAvailablePrice,worstAvailablePrice,executions:g.fills.filter(f=>f.id>priorFill).map(f=>({price:f.price/100,quantity:f.quantity,maker:f.maker}))});addEvent(g,g.botAt,a.id,'system',`Atlas ${side.toUpperCase()} · ${selection} price · requested ${qty}, filled ${result.filledQuantity}.`);}}}
 if(now>=g.endsAt!){g.finalBook=orderBook(g);if(isRelative(g))g.closingValuation=vwapClose(g);else if(g.schema>=6)g.closingValuation={...marketValuation(g),price:g.atlasCenter!,source:'atlas_center'};else if(g.schema>=4)g.closingValuation=marketValuation(g);for(const o of g.orders){const a=g.agents.find(a=>a.id===o.agentId)!;a.expired++;}g.orders=[];g.status='finished';g.finishedAt=g.endsAt;revalue(g);for(const a of g.agents){a.leaseId='';a.leaseUntil=0;}addEvent(g,g.endsAt!,'$system','system',g.schema===2?'Legacy game finished at its fixed settlement. Leaderboard frozen.':g.schema===3?'Historical realized-only round finished.':`Game finished. Closing reference: ${g.closingValuation!.price===null?'unpriced':(g.closingValuation!.price/100).toFixed(3)} (${g.closingValuation!.source}). Total P&L frozen.`);}
}
function throttle(a:Agent,now:number){const window=Math.floor(now/1000);if(a.requestWindow!==window){a.requestWindow=window;a.requestCount=0;}if(++a.requestCount>20)throw new ArenaError('Maximum 20 trading actions per agent per second.',429);}
function signature(input:Intent){return JSON.stringify(Object.fromEntries(['action','side','type','quantity','price','orderId','timeInForce','postOnly'].map(k=>[k,(input as unknown as Record<string,unknown>)[k]??null])));}
function validateOrder(g:Game,a:Agent,input:Intent,orders:Order[]){
 if(!['buy','sell'].includes(input.side||''))throw new ArenaError('Side must be buy or sell.');
 const type=input.type??'limit',tif=input.timeInForce??(type==='market'?'IOC':'GTC');
 if(!['limit','market'].includes(type))throw new ArenaError('Order type must be limit or market.');
 if(!['GTC','IOC'].includes(tif)||type==='market'&&tif!=='IOC')throw new ArenaError('Use GTC or IOC; market orders require IOC.');
 if(input.postOnly!==undefined&&typeof input.postOnly!=='boolean')throw new ArenaError('postOnly must be a boolean.');
 if(input.postOnly&&(tif!=='GTC'||type!=='limit'))throw new ArenaError('postOnly requires a GTC limit order.');
 const max=isRelative(g)?20:1000;
 if(!Number.isInteger(input.quantity)||input.quantity!<1||input.quantity!>max)throw new ArenaError(`Quantity must be an integer from 1 to ${max}.`);
 if(isRelative(g)&&type==='market'&&input.price===undefined)throw new ArenaError('MISSING_PRICE_PROTECTION: supply a maximum buy or minimum sell price.');
 const price=type==='limit'||isRelative(g)?cents(input.price):null;
 if(orders.filter(o=>o.agentId===a.id).length>=50)throw new ArenaError('Cancel an order before placing another (50 open orders maximum).');
 if(isRelative(g)){const capacity=riskCapacity(g,a,orders),free=input.side==='buy'?capacity.buyCapacity!:capacity.sellCapacity!;if(input.quantity!>free)throw new ArenaError(`POSITION_LIMIT: ${input.side} capacity is ${free}; position and all same-side resting orders reserve capacity.`);}
 const opposite=sorted({...g,orders},input.side==='buy'?'sell':'buy')[0];
 if(input.postOnly&&opposite&&(input.side==='buy'?opposite.price<=price!:opposite.price>=price!))throw new ArenaError('POST_ONLY_WOULD_CROSS: order would immediately execute.');
 return {type,tif,price};
}
export function intent(g:Game,a:Agent,input:Intent,now:number,requestId?:string){
 if(requestId){if(typeof requestId!=='string'||requestId.length>100)throw new ArenaError('Request IDs must be strings up to 100 characters.');const prior=g.receipts.find(r=>r.id===requestId&&r.agentId===a.id);if(prior){if(isRelative(g)&&prior.signature!==signature(input))throw new ArenaError('IDEMPOTENCY_CONFLICT: request ID was used with different arguments.',409);return prior.result;}}
 ensureRunning(g,now);throttle(a,now);let result:unknown;
 if(input.action==='wait'){result={status:'waiting'};}
 else if(input.action==='cancel_all'){const own=g.orders.filter(o=>o.agentId===a.id);g.orders=g.orders.filter(o=>o.agentId!==a.id);a.cancellations+=own.length;result={status:'canceled',canceled:own.length};addEvent(g,now,a.id,'cancel',`Canceled ${own.length} open orders.`);}
 else if(input.action==='cancel_order'){const o=g.orders.find(o=>o.id===input.orderId&&o.agentId===a.id);if(!o)throw new ArenaError('Order not found, already filled, or not owned by this agent.',404);g.orders=g.orders.filter(x=>x.id!==o.id);a.cancellations++;result={status:'canceled',orderId:o.id};addEvent(g,now,a.id,'cancel',`Canceled ${o.id}.`);}
 else if(input.action==='place_order'||input.action==='replace_order'){
  const replacing=input.action==='replace_order'?g.orders.find(o=>o.id===input.orderId&&o.agentId===a.id):undefined;
  if(input.action==='replace_order'&&!replacing)throw new ArenaError('Order not found, already filled, or not owned by this agent.',404);
  const orders=replacing?g.orders.filter(o=>o.id!==replacing.id):g.orders;
  const normalized=validateOrder(g,a,input,orders);
  // Validation happens before removing the old order, so a failed replace leaves it intact.
  if(replacing){g.orders=orders;a.cancellations++;}
  result={...match(g,a,input.side!,normalized.tif==='IOC'?'market':normalized.type,input.quantity!,normalized.price,now),...(replacing?{replacedOrderId:replacing.id}:{})};
  addEvent(g,now,a.id,'order',`${input.side!.toUpperCase()} ${input.quantity} ${TICKER} · ${normalized.price===null?'market':(normalized.price/100).toFixed(2)} · ${normalized.tif}`);
 }else throw new ArenaError('Unknown trading action.');
 if(requestId){g.receipts.push({agentId:a.id,id:requestId,result,signature:signature(input)});g.receipts=g.receipts.slice(-500);}revalue(g);return result;
}
export function agentStats(a:Agent,legacy=false,mark?:number|null){return {id:a.id,preset:a.preset,name:a.name,provider:a.provider,model:a.model,strategy:a.strategy,intervalMs:a.intervalMs,position:a.position,cash:a.cash/100,averageEntry:a.position?a.average/100:null,realizedPnl:a.realized/100,pnl:pnl(a,legacy,mark)/100,unrealizedPnl:mark==null?null:a.position*(mark-a.average)/100,entryNotional:Math.abs(a.position)*a.average/100,orders:a.orders,submittedQuantity:a.submittedQuantity,filledQuantity:a.filledQuantity,fills:a.fills,makerFills:a.makerFills,takerFills:a.takerFills,cancellations:a.cancellations,expiredOrders:a.expired,fillRate:a.submittedQuantity?a.filledQuantity/a.submittedQuantity:0,peakPosition:a.peakPosition,maxDrawdown:a.maxDrawdown/100,calls:a.calls,historyMessages:a.historyMessages??0,errors:a.errors,averageLatencyMs:a.latencySamples?a.latencyMs/a.latencySamples:0,promptTokens:a.promptTokens,completionTokens:a.completionTokens};}
const BEST_ONLY_BOT='Historical Atlas: every 10 seconds it randomly buys or sells 1–5 contracts at the best available prices, using normal price priority. It never quotes.';
export function rulesFor(g:Game){
 if(isRelative(g))return {...RULES,durationSeconds:durationOf(g)/1000};
 if(g.schema===9)return {...HIDDEN_CENTER_RULES,durationSeconds:durationOf(g)/1000};
 if(g.schema>=7)return {...HIDDEN_CENTER_V1_RULES,durationSeconds:durationOf(g)/1000};
 if(g.schema===6)return {...HIDDEN_CENTER_V1_RULES,durationSeconds:durationOf(g)/1000,bot:HIDDEN_CENTER_V1_RULES.bot.replace(/Atlas randomness derives.*$/,'Atlas randomness combined the game seed with a secret per-game nonce, revealed at the end.'),botRandomness:'Historical schema-6 round: the center and arrivals came from an LCG seeded by the public seed and a secret 32-bit nonce, revealed at the close. No commitment was published.'};
 const rules=g.schema>=5?BEST_WORST_RULES:{...BEST_WORST_RULES,botExecutionMode:'best' as const,botBestProbability:1,botWorstProbability:0,bot:BEST_ONLY_BOT,matching:'Price priority, then FIFO. Market orders sweep available prices; any unfilled market quantity is canceled. Limit remainders rest. Self-matches cancel your resting leg.'};
 if(g.schema===2)return {...rules,openingPrice:50,botIntervalSeconds:1,bot:'Legacy Atlas: once per second, 60 best-price attempts.',scoring:'Legacy game: cash + position × 50.00.',scoringMode:'legacy_fixed' as const};
 if(g.schema===3)return {...rules,scoring:'Historical round: realized P&L only; open inventory is not valued.',scoringMode:'realized' as const};
 return rules;
}
// While a schema-6 game runs, only executions are public: limits, unfilled arrivals, and the center would reveal C.
function atlasHidden(g:Game){return g.schema>=6&&!isRelative(g)&&g.status!=='finished';}
function atlasPublic(g:Game,legacy:boolean,mark:number|null){const s=agentStats(g.agents.find(a=>a.id==='$atlas')!,legacy,mark),hidden=atlasHidden(g);return {...s,orders:hidden?null:s.orders,submittedQuantity:hidden?null:s.submittedQuantity,fillRate:hidden?null:s.fillRate,...botInfo(g),attempts:hidden?null:g.botAttempts,maxAttempts:g.schema>=6?(hidden||isRelative(g)&&g.status!=='finished'?null:g.atlasPlan?.length??0):durationOf(g)/(legacy?1000:BOT_INTERVAL_MS)};}
function botInfo(g:Game){const ticks=g.botTicks??[];
 if(isRelative(g))return {executionMode:'limit_ioc' as const,meanIntervalMs:1000,commitment:g.atlasCommitment??null,center:null,nonce:null,secret:g.status==='finished'?g.atlasSecret??null:null,ticks};
 if(g.schema>=6){const hidden=atlasHidden(g);return {executionMode:'limit_ioc' as const,meanIntervalMs:ATLAS_MEAN_INTERVAL_MS,commitment:g.atlasCommitment??null,center:hidden?null:g.atlasCenter!/100,nonce:hidden?null:g.atlasNonce??null,secret:hidden?null:g.atlasSecret??null,ticks:hidden?ticks.filter(t=>t.filledQuantity>0).map(({time,side,filledQuantity,averageFillPrice,executions})=>({time,side,filledQuantity,averageFillPrice,executions})):ticks};}
 return {executionMode:g.schema>=5?'best_worst_50_50' as const:'best' as const,bestAttempts:g.schema>=5?ticks.filter(t=>t.selection==='best').length:g.botAttempts,worstAttempts:ticks.filter(t=>t.selection==='worst').length,bestFilledQuantity:g.schema>=5?ticks.filter(t=>t.selection==='best').reduce((q,t)=>q+t.filledQuantity,0):g.agents.find(a=>a.id==='$atlas')!.filledQuantity,worstFilledQuantity:ticks.filter(t=>t.selection==='worst').reduce((q,t)=>q+t.filledQuantity,0),ticks};}
export function publicState(g:Game,now:number){
 const legacy=g.schema===2,mark=valuation(g).price,scoreMode=g.schema===2?'legacy_fixed' as const:g.schema===3?'realized' as const:isRelative(g)?'market_vwap' as const:g.schema>=6?'hidden_center' as const:'closing_midpoint' as const,agents=g.agents.filter(a=>a.id!=='$atlas').map(a=>agentStats(a,legacy,mark)),leaderboard=[...agents].sort((a,b)=>b.pnl-a.pnl||b.filledQuantity-a.filledQuantity||a.name.localeCompare(b.name)).map((a,i)=>({...a,rank:i+1}));
 return {botMode:botModeOf(g),modeName:isRelative(g)?'Market relative':g.schema>=6?'Hidden center':'Historical Atlas',settlement:g.settlement??null,id:g.id,ticker:TICKER,status:g.status,createdAt:g.createdAt,startedAt:g.startedAt,endsAt:g.endsAt,finishedAt:g.finishedAt,now,remainingMs:g.status==='lobby'?durationOf(g):Math.max(0,g.endsAt!-now),durationMs:durationOf(g),seed:g.seed,rules:rulesFor(g),scoringMode:scoreMode,valuation:publicValuation(g),settlementPrice:legacy?LEGACY_SETTLEMENT_CENTS/100:g.status==='finished'&&mark!==null?mark/100:null,botIntervalMs:isRelative(g)?1000:legacy?1000:g.schema>=6?ATLAS_MEAN_INTERVAL_MS:BOT_INTERVAL_MS,lastPrice:g.lastPrice===null?null:g.lastPrice/100,firstPrice:legacy?(g.series[0]?.price??null):(g.firstPrice==null?null:g.firstPrice/100),volume:g.volume,book:g.status==='finished'?g.finalBook!:orderBook(g),agents,leaderboard,atlas:atlasPublic(g,legacy,mark),fills:g.fills.slice(-100).reverse().map(f=>({...f,price:f.price/100,makerName:g.agents.find(a=>a.id===f.maker)?.name,takerName:g.agents.find(a=>a.id===f.taker)?.name})),events:g.events.slice(-100).reverse(),series:g.series};
}
export function observation(g:Game,a:Agent,now:number){return {botMode:botModeOf(g),riskCapacity:riskCapacity(g,a),gameId:g.id,ticker:TICKER,status:g.status,remainingMs:g.status==='lobby'?durationOf(g):Math.max(0,g.endsAt!-now),durationMs:durationOf(g),serverTime:now,rules:rulesFor(g),atlas:{...botInfo(g),intervalMs:isRelative(g)?1000:g.schema>=6?ATLAS_MEAN_INTERVAL_MS:g.schema===2?1000:BOT_INTERVAL_MS,attempts:atlasHidden(g)?null:g.botAttempts},scoringMode:rulesFor(g).scoringMode,valuation:publicValuation(g),lastPrice:g.lastPrice===null?null:g.lastPrice/100,book:g.status==='finished'?g.finalBook!:orderBook(g),position:agentStats(a,g.schema===2,valuation(g).price),openOrders:g.orders.filter(o=>o.agentId===a.id).map(o=>({...o,price:o.price/100})),recentFills:g.fills.slice(-10).reverse().map(f=>({...f,price:f.price/100}))};}
const BEST_WORST_RULES={ticker:TICKER,durationSeconds:60,priceRange:[0,100],tickSize:0.01,quantityRange:[1,1000],openingPrice:null,startingCash:0,startingInventory:0,longShort:true,fees:0,maxAgents:8,maxOpenOrders:50,maxActionsPerSecond:20,botIntervalSeconds:10,botExecutionMode:'best_worst_50_50' as const,botBestProbability:0.5,botWorstProbability:0.5,botQuantityRange:[1,5],botSideBuyProbability:0.5,scoringMode:'closing_midpoint' as const,matching:'Agent orders use price priority, then FIFO. Market orders sweep available prices; any unfilled quantity is canceled. Limit remainders rest. Self-matches cancel your resting leg. Atlas alone may reverse price priority for its disclosed worst-first executions; FIFO at equal prices is unchanged.',liquidity:'The book and trade history start empty. No opening price or fixed fundamental value is supplied. Competing agents choose all quotes. The first execution establishes the first traded price. No hidden market maker or quote refill.',bot:'Atlas is the only system bot. Every 10 seconds (10, 20, 30, 40, 50, 60), independently sample buy/sell (50/50), a total quantity from 1–5 contracts, and best-first/worst-first execution (50/50). Best buy: lowest asks first; worst buy: highest asks first. Best sell: highest bids first; worst sell: lowest bids first. At equal prices fill oldest orders first. Sweep in the chosen order until the sampled quantity is filled or that side is empty; cancel any remainder. The cap applies across all fills in that attempt. Atlas never quotes or creates liquidity. Worst-first is an explicit exception only for Atlas. All agents are told this mechanism; choices and fills are recorded. The seed determines the random sequence; probabilities do not guarantee exactly three attempts of each mode per game.',scoring:'Final total P&L = cash + position × closing reference price. After the final scheduled Atlas attempt, capture the remaining book before expiring orders. With both sides present, reference = (best bid + best ask) / 2. If either side is missing, use the last executed price. With no two-sided book and no trades, the reference is undefined and all zero-inventory scores are zero. Keep half-tick precision. Realized and unrealized P&L are reported separately; realized P&L is already included in cash, so do not add it again. Inventory is valued without creating liquidation trades. Live P&L uses the same rule on the current book and is provisional. Quotes can influence the closing reference; this is a market mark.',deadline:'Agent actions must arrive before the server deadline. The closing book, reference price, and scores freeze after 60 seconds; then unfilled orders expire. Atlas ticks advance on API access by server timestamps, including all six scheduled attempts when finalizing.',ties:'Equal total P&L ranks by filled quantity, then agent name.'};
const HIDDEN_CENTER_V1_RULES={botMode:'hidden_center' as const,rulesVersion:'hidden-center-v1',ticker:TICKER,durationSeconds:DURATION/1000,durationRange:[MIN_DURATION/1000,MAX_DURATION/1000],priceRange:[0,100],tickSize:0.01,quantityRange:[1,1000],openingPrice:null,startingCash:0,startingInventory:0,longShort:true,fees:0,maxAgents:8,maxOpenOrders:50,maxActionsPerSecond:20,botArrival:'poisson' as const,botMeanIntervalSeconds:ATLAS_MEAN_INTERVAL_MS/1000,botExecutionMode:'limit_ioc' as const,botSideBuyProbability:0.5,botQuantityRange:[1,5],botCenterRange:[ATLAS_CENTER_RANGE_CENTS[0]/100,ATLAS_CENTER_RANGE_CENTS[1]/100],botLimitBand:ATLAS_LIMIT_BAND_CENTS/100,scoringMode:'hidden_center' as const,matching:'Every order, including Atlas, uses price priority, then FIFO. Market orders sweep available prices; any unfilled quantity is canceled. Limit remainders rest. Self-matches cancel your resting leg.',liquidity:'The book and trade history start empty. No opening price is supplied. Competing agents choose all quotes. The first execution establishes the first traded price. No hidden market maker or quote refill.',bot:'Atlas is the only system bot. Each game draws a hidden center price C uniformly from 20.00 to 80.00; C stays fixed for the whole game. Atlas orders arrive at random times (a Poisson process, on average one every 2 seconds). Each arrival independently samples buy or sell (50/50), a quantity of 1–5 contracts, and a limit price uniformly within C ± 5.00. A buy fills only against asks at or below its limit; a sell fills only against bids at or above its limit; best price first, then FIFO. Any unfilled remainder is canceled immediately (immediate-or-cancel). Atlas never quotes or creates liquidity. While the game runs, only Atlas executions are public; C, Atlas limit prices, and unfilled arrivals are revealed when the game ends. Atlas randomness derives from a per-game 256-bit secret, committed by SHA-256 at creation and revealed at the end.',botRandomness:'A 32-byte secret is drawn with a cryptographic generator when the game is created. atlas.commitment = SHA-256(secret) is public from the lobby. The center and every arrival are drawn from SHA-256(secret || seed as uint32 big-endian || counter as uint32 big-endian) digests, consumed as eight big-endian uint32 words per counter and each divided by 2^32: first the center (20.00–80.00 in cents), then per arrival the exponential gap in ms with mean 2000 (rounded, at least 1), side (below 0.5 is buy), quantity (1–5), and limit offset (uniform within ±500 cents). Arrivals stop at the deadline or at a cap of ceil(durationMs / 2000) × 3 + 50. The secret is revealed at the close, so anyone can recompute C and the full plan and compare them with atlas.ticks.',scoring:'Final total P&L = cash + position × C, the hidden Atlas center, revealed when the game ends. Quotes cannot move the final reference. While the game runs, live P&L is provisional: inventory is marked at the current best bid/ask midpoint, or the last executed price if either side is missing. Realized and unrealized P&L are reported separately; realized P&L is already included in cash, so do not add it again. Inventory is valued without liquidation trades.',deadline:'Agent actions must arrive before the server deadline. Atlas arrivals advance on API access by server timestamps; every arrival before the deadline is processed when finalizing. Scores then freeze and unfilled orders expire.',ties:'Equal total P&L ranks by filled quantity, then agent name.'};

export const HIDDEN_CENTER_RULES = {
 ...HIDDEN_CENTER_V1_RULES,
 rulesVersion: 'hidden-center-v2' as const,
 botLimitDistribution: {family:'discrete_truncated_student_t', degreesOfFreedom:OFFSET_DEGREES_OF_FREEDOM, scale:OFFSET_SCALE_CENTS/100, band:LIMIT_BAND_CENTS/100, tickSize:0.01},
 bot: 'Atlas is the only system bot. C is uniform from 20.00 to 80.00 and fixed for the round. Independent Poisson arrivals average one every two seconds. Each independently chooses buy or sell with equal probability, quantity 1–5 uniformly, and an IOC limit C plus a symmetric discrete Student-t offset (1.5 degrees of freedom, scale 1.00, restricted to ±5.00, in 0.01 ticks). About 59% of limits lie within 1.00 of C. A buy trades at resting asks at or below its limit; a sell trades at resting bids at or above its limit, best price then FIFO. Unfilled size is canceled. Only executed Atlas orders are visible during play. The private limits, all arrivals, C and the committed secret are revealed at close.',
 botRandomness: 'Replay SHA-256(secret || seed || counter) using the secret bytes followed by two big-endian uint32 values. Read eight big-endian uint32 words per digest, each divided by 2^32. First draw C uniformly in cents from 2000 through 8000. Each arrival draws its exponential gap (mean 2000 ms, rounded to at least 1 ms), side, size, and one uniform u for its limit. For k=-500 to 500 cents assign weight round(1000000*(1+(k/100)^2/1.5)^(-1.25)). Choose the first k whose cumulative weight exceeds floor(u*totalWeight). Stop before the deadline or at ceil(durationMs/2000)*3+50 arrivals.',
};
export const RULES={...HIDDEN_CENTER_V1_RULES,botMode:'market_relative' as const,rulesVersion:'market-relative-v1',durationSeconds:60,quantityRange:[1,20],maxAbsPosition:20,botMeanIntervalSeconds:1,botCenterRange:null,botLimitBand:null,botToleranceRange:[0.01,0.50],botMaxSpread:1,botRequireTwoSidedBook:true,scoringMode:'market_vwap' as const,
 bot:'Atlas is the only system bot and never quotes. There is no hidden center, fixed fair value, or opening price. Arrivals are Poisson with mean 1 second. Each independently samples buy/sell 50/50, quantity 1–5, and distance D uniformly from 0.01–0.50. At the arrival freeze best bid b and ask a. Skip if either side is missing or spread exceeds 1.00. Otherwise mid=(b+a)/2, buy limit=floor_tick(min(100,mid+D)), sell limit=ceil_tick(max(0,mid-D)). Submit one protected limit IOC at normal best-price/FIFO priority. Never recompute the limit during a sweep. Cancel all remaining quantity; never redraw or queue skipped demand. Agents create every quote and compete for this finite flow.',
 botRandomness:'A 32-byte secret is committed by SHA-256 at creation and revealed at the close. Independent streams use SHA-256(secret bytes || UTF-8("market_relative:" + channel)) as the atlasStream secret, with channels arrivals, sides, sizes, tolerances. Each atlasStream uses SHA-256(derived secret || seed uint32 BE || counter uint32 BE), eight uint32 BE words / 2^32. Sample arrival gaps from -log(1-u)*1000 rounded to >=1 ms, sides u<0.5, quantities 1+floor(u*5), distances 1+floor(u*50) cents. Attempts strictly before the deadline are consumed even when skipped. Replay also requires the action log because prices depend on the evolving book.',
 scoring:'Final total P&L = cash + position × S. S is the quantity-weighted average of all real trades in the last 10 seconds before the deadline. If that window has no trades, use full-round VWAP. With no trades S=null and all zero-inventory scores are zero; never invent 50. VWAP retains fractional-tick precision. Fewer than 10 contracts or 3 independent taker events in the final window is labelled low quality without changing the formula. At the close archive pre-settlement cash/inventory and the cash-settled balances (positionAfter=0). The leaderboard shows inventory at freeze for analysis. Realized P&L is already in cash. Market settlement may be strategically influenced; it is not an external fair value.',
 risk:'Position is bounded to ±20. Reserve every open buy and sell independently: position + remaining buys <=20, position - remaining sells >=-20. IOC reserves its full submitted quantity before matching. Quantity is 1–20. No margin calls. Market orders require an explicit protective price; limit IOC and post-only GTC are supported. Replace validates atomically before canceling the old order, and always loses queue priority.',
 deadline:'Actions must reach the server before the per-game deadline. Process only Atlas arrivals strictly before that deadline, then freeze trades and settlement. Later reads and retries cannot alter the result. The pre-drawn stream is advanced before every committed action and during finalization.',
 liquidity:'The book and history start empty. No opening price or external value is supplied. All prices arise from agent quotes and executions. Atlas requires a two-sided book with spread <=1.00 and never creates liquidity.'};
export function modeRules(mode:unknown=DEFAULT_BOT_MODE){if(!modeConfig(mode))throw new ArenaError('Unknown bot mode.');return mode==='market_relative'?RULES:HIDDEN_CENTER_RULES;}
export {BOT_MODES,DEFAULT_BOT_MODE};

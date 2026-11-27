// Standing strategies: a small formula language the exchange evaluates on a fixed clock, so an agent's quotes keep
// moving between model replies. Formulas are parsed into a tree and interpreted (no eval); null means "no value" and
// propagates through arithmetic, so a quote that cannot be computed is simply not placed.
export type Value=number|null;
export class StrategyError extends Error{}
// Market variables a formula may read. Prices are dollars. bestBid/bestAsk/mid/spread exclude the agent's own orders,
// so a quote defined relative to the book does not chase itself.
export const STRATEGY_VARIABLES=['bestBid','bestAsk','mid','spread','lastPrice','position','averageEntry','pnl','openOrders','remainingMs','elapsedMs','atlasBuys','atlasSells','atlasBuyQty','atlasSellQty','atlasBuyMax','atlasBuyMin','atlasSellMax','atlasSellMin','atlasLastPrice','atlasLastSide','atlasVwap'] as const;
export const STRATEGY_INTERVAL_MS=500,MAX_STRATEGY_ORDERS=6,MAX_STRATEGY_VARS=12,MAX_FORMULA_LENGTH=240;
const FUNCTIONS:Record<string,[number,number]>={min:[1,8],max:[1,8],abs:[1,1],clamp:[3,3],round:[1,2],floor:[1,1],ceil:[1,1],sign:[1,1],sqrt:[1,1],or:[1,8],isnull:[1,1]};
const CONSTANTS:Record<string,Value>={true:1,false:0,null:null};
type Node={k:'num';v:Value}|{k:'var';n:string}|{k:'un';op:string;a:Node}|{k:'bin';op:string;a:Node;b:Node}|{k:'cond';c:Node;a:Node;b:Node}|{k:'call';f:string;args:Node[]};
type Token={t:'num'|'id'|'op';v:string;at:number};
function tokenize(source:string):Token[]{
 const tokens:Token[]=[],pattern=/\s*(?:(\d+(?:\.\d+)?|\.\d+)|([A-Za-z_][A-Za-z0-9_]*)|(&&|\|\||==|!=|<=|>=|[-+*/()?:<>!,]))/y;let at=0;
 while(at<source.length){
  pattern.lastIndex=at;const m=pattern.exec(source);
  if(!m){if(!source.slice(at).trim())break;throw new StrategyError(`unexpected "${source.slice(at).trim()[0]}" at character ${at+1}`);}
  const start=m.index+m[0].length-(m[1]??m[2]??m[3]).length;
  tokens.push(m[1]!==undefined?{t:'num',v:m[1],at:start}:m[2]!==undefined?{t:'id',v:m[2],at:start}:{t:'op',v:m[3],at:start});at=pattern.lastIndex;
 }
 return tokens;
}
// Recursive descent: ternary, ||, &&, comparison, + -, * /, unary, primary.
function parse(source:string,names:ReadonlySet<string>):Node{
 const tokens=tokenize(source);let i=0,nodes=0;
 const fail=(message:string,token=tokens[i]):never=>{throw new StrategyError(token?`${message} at character ${token.at+1}`:`${message} at the end`);};
 const node=<T extends Node>(n:T,depth:number):T=>{if(++nodes>150||depth>30)fail('formula is too large');return n;};
 const op=(...values:string[])=>tokens[i]?.t==='op'&&values.includes(tokens[i].v)?tokens[i++].v:null;
 const expect=(value:string)=>{if(!op(value))fail(`expected "${value}"`);};
 const ternary=(d:number):Node=>{const c=or(d+1);if(!op('?'))return c;const a=ternary(d+1);expect(':');const b=ternary(d+1);return node({k:'cond',c,a,b},d);};
 const binary=(next:(d:number)=>Node,ops:string[],chain:boolean)=>(d:number):Node=>{let left=next(d+1);for(let o=op(...ops);o;o=chain?op(...ops):null)left=node({k:'bin',op:o,a:left,b:next(d+1)},d);return left;};
 const primary=(d:number):Node=>{
  const token=tokens[i];if(!token)return fail('formula is incomplete');
  if(token.t==='num'){i++;return node({k:'num',v:Number(token.v)},d);}
  if(token.t==='id'){
   i++;
   if(op('(')){
    const arity=FUNCTIONS[token.v];if(!arity)fail(`unknown function "${token.v}"`,token);
    const args:Node[]=[];if(!op(')')){do args.push(ternary(d+1));while(op(','));expect(')');}
    if(args.length<arity[0]||args.length>arity[1])fail(`${token.v}() takes ${arity[0]===arity[1]?arity[0]:arity[0]+'–'+arity[1]} argument${arity[1]===1?'':'s'}`,token);
    return node({k:'call',f:token.v,args},d);
   }
   if(token.v in CONSTANTS)return node({k:'num',v:CONSTANTS[token.v]},d);
   if(!names.has(token.v))fail(`unknown name "${token.v}"`,token);
   return node({k:'var',n:token.v},d);
  }
  if(op('(')){const inner=ternary(d+1);expect(')');return inner;}
  return fail(`unexpected "${token.v}"`);
 };
 const unary=(d:number):Node=>{const o=op('-','!','+');return o?node({k:'un',op:o,a:unary(d+1)},d):primary(d);};
 const mul=binary(unary,['*','/'],true),add=binary(mul,['+','-'],true),cmp=binary(add,['==','!=','<','<=','>','>='],false),and=binary(cmp,['&&'],true),or=binary(and,['||'],true);
 const tree=ternary(0);if(i<tokens.length)fail(`unexpected "${tokens[i].v}"`);return tree;
}
const truthy=(v:Value)=>v!==null&&v!==0;
const finite=(v:number):Value=>Number.isFinite(v)?v:null;
function run(n:Node,env:Record<string,Value>):Value{
 switch(n.k){
  case 'num':return n.v;
  case 'var':return env[n.n]??null;
  case 'un':{const a=run(n.a,env);return n.op==='!'?(truthy(a)?0:1):a===null?null:n.op==='-'?-a:a;}
  case 'cond':return truthy(run(n.c,env))?run(n.a,env):run(n.b,env);
  case 'bin':{
   if(n.op==='&&')return truthy(run(n.a,env))&&truthy(run(n.b,env))?1:0;
   if(n.op==='||')return truthy(run(n.a,env))||truthy(run(n.b,env))?1:0;
   const a=run(n.a,env),b=run(n.b,env);
   // A comparison involving a missing value is false, so "bestAsk < 55" cannot fire on an empty book.
   if(['==','!=','<','<=','>','>='].includes(n.op)){if(a===null||b===null)return 0;return (n.op==='=='?a===b:n.op==='!='?a!==b:n.op==='<'?a<b:n.op==='<='?a<=b:n.op==='>'?a>b:a>=b)?1:0;}
   if(a===null||b===null)return null;
   return finite(n.op==='+'?a+b:n.op==='-'?a-b:n.op==='*'?a*b:b===0?NaN:a/b);
  }
  case 'call':{
   const args=n.args.map(x=>run(x,env));
   if(n.f==='or')return args.find(x=>x!==null)??null;
   if(n.f==='isnull')return args[0]===null?1:0;
   if(args.some(x=>x===null))return null;const x=args as number[];
   return finite(n.f==='min'?Math.min(...x):n.f==='max'?Math.max(...x):n.f==='abs'?Math.abs(x[0]):n.f==='clamp'?Math.min(Math.max(x[0],x[1]),x[2]):n.f==='round'?(x[1]===undefined?Math.round(x[0]):x[1]>0?Math.round(x[0]/x[1])*x[1]:NaN):n.f==='floor'?Math.floor(x[0]):n.f==='ceil'?Math.ceil(x[0]):n.f==='sign'?Math.sign(x[0]):Math.sqrt(x[0]));
  }
 }
}
const cache=new Map<string,Node>();
function compiled(source:string,names:ReadonlySet<string>){const key=[...names].join(',')+'\n'+source;let tree=cache.get(key);if(!tree){tree=parse(source,names);if(cache.size>400)cache.clear();cache.set(key,tree);}return tree;}
export function evaluateFormula(source:string,env:Record<string,Value>,names:ReadonlySet<string>=new Set(Object.keys(env))):Value{return run(compiled(source,names),env);}
// The stored program is plain JSON: formula sources, never parsed trees.
export type ProgramSpec={note?:string;vars:[string,string][];orders:{side:'buy'|'sell';price:string;quantity:string;when?:string}[];maxPosition:number;stopWhen?:string};
const formula=(value:unknown,label:string,names:ReadonlySet<string>)=>{
 const source=typeof value==='number'&&Number.isFinite(value)?String(value):typeof value==='string'?value.trim():'';
 if(!source)throw new StrategyError(`${label} needs a formula.`);
 if(source.length>MAX_FORMULA_LENGTH)throw new StrategyError(`${label} is longer than ${MAX_FORMULA_LENGTH} characters.`);
 try{parse(source,names);}catch(e){throw new StrategyError(`Formula error in ${label}: ${e instanceof Error?e.message:'invalid formula'}. Known names: ${[...names].join(', ')}.`);}
 return source;
};
// Validates a set_strategy request and returns the storable program. positionCap is the mode's hard limit.
export function compileProgram(input:any,positionCap:number):ProgramSpec{
 if(!input||typeof input!=='object')throw new StrategyError('Send a strategy object.');
 const names=new Set<string>(STRATEGY_VARIABLES),vars:[string,string][]=[];
 const list=input.vars==null?[]:Array.isArray(input.vars)?input.vars:Object.entries(input.vars).map(([name,value])=>({name,value}));
 if(list.length>MAX_STRATEGY_VARS)throw new StrategyError(`Use at most ${MAX_STRATEGY_VARS} vars.`);
 for(const [i,entry] of list.entries()){
  const name=entry?.name;
  if(typeof name!=='string'||!/^[A-Za-z_][A-Za-z0-9_]{0,23}$/.test(name))throw new StrategyError(`vars[${i}].name must be a short identifier.`);
  if(names.has(name)||name in FUNCTIONS||name in CONSTANTS)throw new StrategyError(`vars[${i}].name "${name}" is already defined.`);
  vars.push([name,formula(entry.value??entry.formula,`vars[${i}] (${name})`,names)]);names.add(name);
 }
 if(!Array.isArray(input.orders)||!input.orders.length||input.orders.length>MAX_STRATEGY_ORDERS)throw new StrategyError(`orders must list 1–${MAX_STRATEGY_ORDERS} order slots.`);
 const orders=input.orders.map((o:any,i:number)=>{
  if(!o||!['buy','sell'].includes(o.side))throw new StrategyError(`orders[${i}].side must be buy or sell.`);
  return {side:o.side as 'buy'|'sell',price:formula(o.price,`orders[${i}].price`,names),quantity:formula(o.quantity,`orders[${i}].quantity`,names),...(o.when==null||o.when===''?{}:{when:formula(o.when,`orders[${i}].when`,names)})};
 });
 if(!Number.isInteger(input.maxPosition)||input.maxPosition<1||input.maxPosition>positionCap)throw new StrategyError(`maxPosition must be an integer from 1 to ${positionCap}.`);
 if(input.note!=null&&typeof input.note!=='string')throw new StrategyError('note must be text.');
 return {...(input.note?.trim()?{note:input.note.trim().slice(0,200)}:{}),vars,orders,maxPosition:input.maxPosition,...(input.stopWhen==null||input.stopWhen===''?{}:{stopWhen:formula(input.stopWhen,'stopWhen',names)})};
}
export type OrderTarget={side:'buy'|'sell';active:boolean;price:number|null;quantity:number;problem?:string};
// One evaluation: user vars in order, then the stop condition and every order slot. Prices are rounded to the tick.
export function evaluateProgram(spec:ProgramSpec,base:Record<string,Value>):{vars:Record<string,Value>;stop:boolean;orders:OrderTarget[]}{
 const env:Record<string,Value>={...base},names=new Set<string>(STRATEGY_VARIABLES),vars:Record<string,Value>={};
 for(const [name,source] of spec.vars){env[name]=vars[name]=evaluateFormula(source,env,names);names.add(name);}
 const value=(source:string)=>evaluateFormula(source,env,names);
 const stop=spec.stopWhen?truthy(value(spec.stopWhen)):false;
 const orders=spec.orders.map(o=>{
  const wanted=o.when?truthy(value(o.when)):true,raw=value(o.price),amount=value(o.quantity),price=raw===null?null:Math.round(raw*100)/100,quantity=amount===null?0:Math.max(0,Math.floor(amount+1e-9));
  const problem=!wanted?undefined:price===null?'price has no value':price<0||price>100?'price is outside 0–100':quantity<1?'quantity is below 1':undefined;
  return {side:o.side,active:wanted&&!problem,price:price!==null&&price>=0&&price<=100?price:null,quantity,...(problem?{problem}:{})};
 });
 return {vars,stop,orders};
}

// A mode is fixed when the lobby is created; its bot and scoring rules travel together.
export const BOT_MODES = [
 {id:'market_relative',name:'Market relative',description:'Atlas follows the current book midpoint with protected IOC orders. No hidden value. Settlement uses the last 10 seconds of trades.',defaultDurationSeconds:60,meanIntervalSeconds:1,scoring:'Last 10s VWAP',maxPosition:20,maxQuantity:20},
 {id:'hidden_center',name:'Hidden center',description:'Infer a fixed hidden value C from Atlas executions. Atlas limits cluster around C using a bounded Student-t distribution within ±5. Inventory settles at C.',defaultDurationSeconds:180,meanIntervalSeconds:2,scoring:'Hidden center C',maxPosition:null,maxQuantity:1000},
] as const;
export type BotMode=typeof BOT_MODES[number]['id'];
export const DEFAULT_BOT_MODE:BotMode='market_relative';
export function modeConfig(value:unknown=DEFAULT_BOT_MODE){return BOT_MODES.find(m=>m.id===value);}

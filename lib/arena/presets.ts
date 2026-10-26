// Public metadata only. The shared credential is resolved in server code.
export const DEFAULT_AGENTS = [
 {preset:'sail-glm',name:'GLM 5.3',provider:'sail' as const,model:'zai-org/GLM-5.3',size:'753B · 40B active',intervalMs:4000},
 {preset:'sail-glm-flash',name:'GLM 5.3 Flash',provider:'sail' as const,model:'zai-org/GLM-5.3-Flash',size:'321B · 18B active',intervalMs:4000},
 {preset:'sail-deepseek',name:'DeepSeek V4.1 Flash',provider:'sail' as const,model:'deepseek-ai/DeepSeek-V4.1-Flash',size:'552B · 16B active',intervalMs:4000},
 {preset:'sail-gemma-31',name:'Gemma 4 · 31B',provider:'sail' as const,model:'google/gemma-4-31B-it',size:'31B parameters',intervalMs:4000},
 {preset:'sail-gemma-31-nvfp4',name:'Gemma 4 · 31B NVFP4',provider:'sail' as const,model:'nvidia/Gemma-4-31B-IT-NVFP4',size:'31B · NVFP4 · 262K context',intervalMs:4000},
 {preset:'sail-glm-flash-2',name:'GLM 5.3 Flash · II',provider:'sail' as const,model:'zai-org/GLM-5.3-Flash',size:'321B · independent run II',intervalMs:4000},
 {preset:'sail-deepseek-2',name:'DeepSeek V4.1 Flash · II',provider:'sail' as const,model:'deepseek-ai/DeepSeek-V4.1-Flash',size:'552B · independent run II',intervalMs:4000},
 {preset:'sail-gemma-31-2',name:'Gemma 4 · 31B · II',provider:'sail' as const,model:'google/gemma-4-31B-it',size:'31B · independent run II',intervalMs:4000},
];
export function defaultAgent(preset:unknown){return DEFAULT_AGENTS.find(a=>a.preset===preset);}
export const DEFAULT_MAX_TOKENS=1536;
export const DEFAULT_MAX_DECISIONS=15;
export const DEFAULT_MAX_MODEL_CALLS=DEFAULT_MAX_DECISIONS*2;
export const DEFAULT_STRATEGY='Trade actively to maximize final total P&L, including inventory valued at the closing midpoint or last-trade fallback. Atlas is a system trader: every 10 seconds it independently chooses buy or sell (50/50), a total quantity of 1–5, and best-first or worst-first execution (50/50). A buy takes lowest asks in best mode or highest asks in worst mode; a sell takes highest bids in best mode or lowest bids in worst mode. FIFO applies at equal prices and the total fill never exceeds the sampled quantity. Only Atlas may bypass normal price priority. This mechanism is public to all agents. Choose your own opening quotes when the book is empty; no price or fundamental value is supplied. Adapt to other agents, executed trades, inventory, and the remaining time. Inspect your existing orders before replacing quotes; avoid accumulating redundant orders. Use at most four tools per response. Keep reasoning brief and return trading tool calls.';

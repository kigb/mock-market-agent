// Public metadata only. The shared credential is resolved in server code.
// Six arena-provided Sail agents forming a speed ladder: DeepSeek V4.1 Flash with reasoning off, GLM 5.3 Flash at two
// reasoning tiers, the full GLM 5.3 at the same two tiers (so size and reasoning budget vary one at a time), and DeepSeek
// V4 Pro at low reasoning as the slowest large-model control.
// Sail rejects reasoning_effort "none" for the GLM family (HTTP 400); "low" is its lowest native tier.
// Use the dated DeepSeek ID: the undated alias timed out on every call, the dated endpoint answers in about a second.
export type PresetReasoningEffort='none'|'low'|'medium'|'high';
// maxTokens overrides DEFAULT_MAX_TOKENS for slots whose reasoning tokens would otherwise exhaust the completion budget.
export const DEFAULT_AGENTS:{preset:string;name:string;provider:'sail';model:string;size:string;intervalMs:number;reasoningEffort?:PresetReasoningEffort;maxTokens?:number}[] = [
 {preset:'sail-deepseek',name:'DeepSeek V4.1 Flash',provider:'sail',model:'deepseek-ai/DeepSeek-V4.1-Flash-1017',size:'552B MoE · 16B active · reasoning off',intervalMs:0,reasoningEffort:'none'},
 {preset:'sail-glm-flash',name:'GLM 5.3 Flash · low',provider:'sail',model:'zai-org/GLM-5.3-Flash',size:'321B MoE · 18B active · reasoning low',intervalMs:0,reasoningEffort:'low'},
 {preset:'sail-glm-flash-medium',name:'GLM 5.3 Flash · medium',provider:'sail',model:'zai-org/GLM-5.3-Flash',size:'321B MoE · 18B active · reasoning medium',intervalMs:0,reasoningEffort:'medium'},
 {preset:'sail-glm-low',name:'GLM 5.3 · low',provider:'sail',model:'zai-org/GLM-5.3',size:'753B MoE · 40B active · reasoning low',intervalMs:0,reasoningEffort:'low'},
 {preset:'sail-glm-medium',name:'GLM 5.3 · medium',provider:'sail',model:'zai-org/GLM-5.3',size:'753B MoE · 40B active · reasoning medium',intervalMs:0,reasoningEffort:'medium'},
 {preset:'sail-deepseek-pro',name:'DeepSeek V4 Pro · low',provider:'sail',model:'deepseek-ai/DeepSeek-V4-Pro-0813',size:'V4 Pro · large MoE · reasoning low',intervalMs:0,reasoningEffort:'low'},
];
export function defaultAgent(preset:unknown){return DEFAULT_AGENTS.find(a=>a.preset===preset);}
// 4096 so reasoning models can finish thinking and still return tool calls; fast models use well under 1,000.
export const DEFAULT_MAX_TOKENS=4096;
// Preset agents are free-running (intervalMs 0). The per-game call cap assumes at most one decision every 2 s plus one
// follow-up call each, scaled by the round length; the daily shared allowance bounds the rest.
export const PRESET_MIN_CADENCE_MS=2000;
export function presetCallLimit(durationMs:number){return Math.ceil(durationMs/PRESET_MIN_CADENCE_MS)*2;}
export const DEFAULT_MAX_DECISIONS=90;
export const DEFAULT_MAX_MODEL_CALLS=DEFAULT_MAX_DECISIONS*2;
export const DEFAULT_STRATEGY='Trade actively to maximize final total P&L, using the settlement rule of the selected game mode. Choose your own opening quotes when the book is empty; no price is supplied. Infer a hidden value only if the selected rules define one. Adapt to other agents, executed trades, inventory, and the remaining time. Inspect your existing orders before replacing quotes; avoid accumulating redundant orders. Start with one or two sentences of visible reasoning, then return trading tool calls in the same reply.';

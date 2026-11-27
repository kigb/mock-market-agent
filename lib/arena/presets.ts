export type PresetReasoningEffort='none'|'low'|'medium'|'high';
// maxTokens overrides DEFAULT_MAX_TOKENS for slots whose reasoning tokens would otherwise exhaust the completion budget.
export type ProvidedAgent = {
 preset:string; name:string; provider:'fireworks'|'sail'; model:string; size:string; intervalMs:number;
 reasoningEffort?:PresetReasoningEffort; maxTokens?:number;
};
export const DEFAULT_AGENTS:ProvidedAgent[] = [
 {preset:'fw-deepseek',name:'DeepSeek V4.1 Flash',provider:'fireworks',model:'accounts/fireworks/models/deepseek-v4p1-flash-1017',size:'Flash · reasoning off',intervalMs:0,reasoningEffort:'none'},
 {preset:'fw-glm-flash',name:'GLM 5.3 Flash · low',provider:'fireworks',model:'accounts/fireworks/models/glm-5p3-flash',size:'Flash · reasoning low',intervalMs:0,reasoningEffort:'low'},
 {preset:'fw-glm-flash-medium',name:'GLM 5.3 Flash · medium',provider:'fireworks',model:'accounts/fireworks/models/glm-5p3-flash',size:'Flash · reasoning medium',intervalMs:0,reasoningEffort:'medium'},
 {preset:'fw-glm-low',name:'GLM 5.3 · low',provider:'fireworks',model:'accounts/fireworks/models/glm-5p3',size:'Full model · reasoning low',intervalMs:0,reasoningEffort:'low'},
 {preset:'fw-glm-medium',name:'GLM 5.3 · medium',provider:'fireworks',model:'accounts/fireworks/models/glm-5p3',size:'Full model · reasoning medium',intervalMs:0,reasoningEffort:'medium'},
 {preset:'fw-kimi-pro',name:'Kimi K3.1 Pro · low',provider:'fireworks',model:'accounts/fireworks/models/kimi-k3p1-pro',size:'Pro · reasoning low',intervalMs:0,reasoningEffort:'low'},
];

// Retain the original identifiers and configuration for existing Sail games and Sail-only installations.
export const SAIL_AGENTS:ProvidedAgent[] = [
 {preset:'sail-deepseek',name:'DeepSeek V4.1 Flash',provider:'sail',model:'deepseek-ai/DeepSeek-V4.1-Flash-1017',size:'552B MoE · 16B active · reasoning off',intervalMs:0,reasoningEffort:'none'},
 {preset:'sail-glm-flash',name:'GLM 5.3 Flash · low',provider:'sail',model:'zai-org/GLM-5.3-Flash',size:'321B MoE · 18B active · reasoning low',intervalMs:0,reasoningEffort:'low'},
 {preset:'sail-glm-flash-medium',name:'GLM 5.3 Flash · medium',provider:'sail',model:'zai-org/GLM-5.3-Flash',size:'321B MoE · 18B active · reasoning medium',intervalMs:0,reasoningEffort:'medium'},
 {preset:'sail-glm-low',name:'GLM 5.3 · low',provider:'sail',model:'zai-org/GLM-5.3',size:'753B MoE · 40B active · reasoning low',intervalMs:0,reasoningEffort:'low'},
 {preset:'sail-glm-medium',name:'GLM 5.3 · medium',provider:'sail',model:'zai-org/GLM-5.3',size:'753B MoE · 40B active · reasoning medium',intervalMs:0,reasoningEffort:'medium'},
 {preset:'sail-deepseek-pro',name:'DeepSeek V4 Pro · low',provider:'sail',model:'deepseek-ai/DeepSeek-V4-Pro-0813',size:'V4 Pro · large MoE · reasoning low',intervalMs:0,reasoningEffort:'low'},
];
export function defaultAgent(preset:unknown){return DEFAULT_AGENTS.find(a=>a.preset===preset)??SAIL_AGENTS.find(a=>a.preset===preset);}
export function providedLineup(fireworks:boolean,sail:boolean) {
 const agents = fireworks || !sail ? DEFAULT_AGENTS : SAIL_AGENTS;
 return {agents,available:fireworks||sail,providers:{fireworks,sail}};
}
// 4096 so reasoning models can finish thinking and still return tool calls; fast models use well under 1,000.
export const DEFAULT_MAX_TOKENS=4096;
// Preset agents are free-running (intervalMs 0). The per-game call cap assumes at most one decision every 2 s plus one
// follow-up call each, scaled by the round length; the daily shared allowance bounds the rest.
export const PRESET_MIN_CADENCE_MS=2000;
export function presetCallLimit(durationMs:number){return Math.ceil(durationMs/PRESET_MIN_CADENCE_MS)*2;}
export const DEFAULT_MAX_DECISIONS=90;
export const DEFAULT_MAX_MODEL_CALLS=DEFAULT_MAX_DECISIONS*2;
export const DEFAULT_STRATEGY='Trade actively to maximize final total P&L, using the settlement rule of the selected game mode. Choose your own opening quotes when the book is empty; no price is supplied. Infer a hidden value only if the selected rules define one. Adapt to other agents, executed trades, inventory, and the remaining time. Inspect your existing orders before replacing quotes; avoid accumulating redundant orders. Start with one or two sentences of visible reasoning, then return trading tool calls in the same reply.';

// Competing agents per lobby, in addition to Atlas.
export const MAX_AGENTS=10;
export type PresetReasoningEffort='none'|'low'|'medium'|'high';
// maxTokens overrides DEFAULT_MAX_TOKENS for slots whose reasoning tokens would otherwise exhaust the completion budget.
export type ProvidedAgent = {
 preset:string; name:string; provider:'fireworks'|'sail'; model:string; size:string; intervalMs:number;
 reasoningEffort:PresetReasoningEffort; maxTokens?:number; strategyTools?:boolean;
};
// Fireworks strategy experiment (the default) and the original six-seat roster.
const FW='accounts/fireworks/models/';
export const DEFAULT_AGENTS:ProvidedAgent[] = [
 {preset:'fw-deepseek-flash',name:'DeepSeek V4.1 Flash · off',provider:'fireworks',model:FW+'deepseek-v4p1-flash-1017',size:'DeepSeek · 755B · reasoning off',intervalMs:0,reasoningEffort:'none'},
 {preset:'fw-glm-low',name:'GLM 5.3 · low',provider:'fireworks',model:FW+'glm-5p3',size:'Z.ai · 743B · reasoning low',intervalMs:0,reasoningEffort:'low'},
 {preset:'fw-minimax',name:'MiniMax M3 · low',provider:'fireworks',model:FW+'minimax-m3',size:'MiniMax · 428B MoE · 23B active · reasoning low',intervalMs:0,reasoningEffort:'low'},
 {preset:'fw-minimax-strategy',name:'MiniMax M3 · low + strategy',provider:'fireworks',model:FW+'minimax-m3',size:'MiniMax · 428B MoE · 23B active · reasoning low · plan and strategy tools',intervalMs:0,reasoningEffort:'low',strategyTools:true},
 {preset:'fw-gpt-oss',name:'gpt-oss-120b · medium',provider:'fireworks',model:FW+'gpt-oss-120b',size:'OpenAI · 116B · reasoning medium',intervalMs:0,reasoningEffort:'medium'},
 {preset:'fw-muse-spark',name:'Muse Spark Open · medium',provider:'fireworks',model:FW+'muse-spark-open',size:'Meta · 816B MoE · 42B active · reasoning medium',intervalMs:0,reasoningEffort:'medium'},
 {preset:'fw-glm-high',name:'GLM 5.3 · high',provider:'fireworks',model:FW+'glm-5p3',size:'Z.ai · 743B · reasoning high',intervalMs:0,reasoningEffort:'high'},
 {preset:'fw-kimi-pro-high',name:'Kimi K3.1 Pro · high',provider:'fireworks',model:FW+'kimi-k3p1-pro',size:'Moonshot · 2.8T MoE · 104B active · reasoning high',intervalMs:0,reasoningEffort:'high'},
 {preset:'fw-kimi-pro-strategy',name:'Kimi K3.1 Pro · high + strategy',provider:'fireworks',model:FW+'kimi-k3p1-pro',size:'Moonshot · 2.8T MoE · 104B active · reasoning high · plan and strategy tools',intervalMs:0,reasoningEffort:'high',strategyTools:true},
];

export const CLASSIC_AGENTS:ProvidedAgent[] = [
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
export const FIREWORKS_LINEUPS = {strategy: DEFAULT_AGENTS, classic: CLASSIC_AGENTS};
export type FireworksLineup = keyof typeof FIREWORKS_LINEUPS;
export function defaultAgent(preset:unknown){return DEFAULT_AGENTS.find(a=>a.preset===preset)??CLASSIC_AGENTS.find(a=>a.preset===preset)??SAIL_AGENTS.find(a=>a.preset===preset);}
export function providedLineup(fireworks:boolean,sail:boolean,lineup:FireworksLineup='strategy') {
 const agents = fireworks || !sail ? FIREWORKS_LINEUPS[lineup] : SAIL_AGENTS;
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

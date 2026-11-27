// Public metadata only. The shared credentials are resolved in server code.
// Nine arena-provided Fireworks agents. Seven are plain agents from six model labs across four reasoning tiers: DeepSeek
// V4.1 Flash with reasoning off, GLM 5.3 and MiniMax M3 at low, gpt-oss-120b and Muse Spark Open at medium, GLM 5.3 and
// Kimi K3.1 Pro at high. GLM 5.3 appears at low and high so one model is compared across reasoning budgets. The last two
// repeat MiniMax M3 · low and Kimi K3.1 Pro · high with strategyTools (a plan tool and a standing strategy the exchange
// runs between replies), so each treated model plays in the same game as its own untreated control.
// Every ID is listed on Fireworks as serverless with function calling. Each slot states its effort explicitly because a
// live probe with the arena's own prompt and tools showed that the provider default spends the whole 4,096-token
// completion on thinking, with no tool call, for DeepSeek V4.1 Flash and GLM 5.3. The same probe fixed the tiers:
// DeepSeek V4.1 Flash only fits with reasoning off, gpt-oss-120b overruns at high and rejects none, and GLM 5.3 and Muse
// Spark reject none. Qwen 3.8 Max was dropped for cost: with reasoning off it is the fastest slot at $2 per million
// input tokens, by an estimate from 60-second rounds about two thirds of a full game's list-price spend.
export type PresetProvider='sail'|'fireworks';
export type PresetReasoningEffort='none'|'low'|'medium'|'high';
// maxTokens overrides DEFAULT_MAX_TOKENS for slots whose reasoning tokens would otherwise exhaust the completion budget.
const FW='accounts/fireworks/models/';
export const DEFAULT_AGENTS:{preset:string;name:string;provider:PresetProvider;model:string;size:string;intervalMs:number;reasoningEffort:PresetReasoningEffort;maxTokens?:number;strategyTools?:boolean}[] = [
 {preset:'fw-deepseek-flash',name:'DeepSeek V4.1 Flash · off',provider:'fireworks',model:FW+'deepseek-v4p1-flash-1017',size:'DeepSeek · 755B · reasoning off',intervalMs:0,reasoningEffort:'none'},
 {preset:'fw-glm-low',name:'GLM 5.3 · low',provider:'fireworks',model:FW+'glm-5p3',size:'Z.ai · 743B · reasoning low',intervalMs:0,reasoningEffort:'low'},
 {preset:'fw-minimax',name:'MiniMax M3 · low',provider:'fireworks',model:FW+'minimax-m3',size:'MiniMax · 428B MoE · 23B active · reasoning low',intervalMs:0,reasoningEffort:'low'},
 {preset:'fw-minimax-strategy',name:'MiniMax M3 · low + strategy',provider:'fireworks',model:FW+'minimax-m3',size:'MiniMax · 428B MoE · 23B active · reasoning low · plan and strategy tools',intervalMs:0,reasoningEffort:'low',strategyTools:true},
 {preset:'fw-gpt-oss',name:'gpt-oss-120b · medium',provider:'fireworks',model:FW+'gpt-oss-120b',size:'OpenAI · 116B · reasoning medium',intervalMs:0,reasoningEffort:'medium'},
 {preset:'fw-muse-spark',name:'Muse Spark Open · medium',provider:'fireworks',model:FW+'muse-spark-open',size:'Meta · 816B MoE · 42B active · reasoning medium',intervalMs:0,reasoningEffort:'medium'},
 {preset:'fw-glm-high',name:'GLM 5.3 · high',provider:'fireworks',model:FW+'glm-5p3',size:'Z.ai · 743B · reasoning high',intervalMs:0,reasoningEffort:'high'},
 {preset:'fw-kimi-pro',name:'Kimi K3.1 Pro · high',provider:'fireworks',model:FW+'kimi-k3p1-pro',size:'Moonshot · 2.8T MoE · 104B active · reasoning high',intervalMs:0,reasoningEffort:'high'},
 {preset:'fw-kimi-pro-strategy',name:'Kimi K3.1 Pro · high + strategy',provider:'fireworks',model:FW+'kimi-k3p1-pro',size:'Moonshot · 2.8T MoE · 104B active · reasoning high · plan and strategy tools',intervalMs:0,reasoningEffort:'high',strategyTools:true},
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

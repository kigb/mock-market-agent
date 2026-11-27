export type TokenUsage = {
  promptTokens: number;
  completionTokens: number;
  cachedPromptTokens?: number | null;
};

type TokenTotals = TokenUsage & { cacheReportedPromptTokens?: number | null };

export function addTokenUsage(totals: TokenTotals, usage: TokenUsage) {
  totals.promptTokens += usage.promptTokens;
  totals.completionTokens += usage.completionTokens;
  if (usage.cachedPromptTokens != null) {
    totals.cachedPromptTokens = (totals.cachedPromptTokens ?? 0) + usage.cachedPromptTokens;
    totals.cacheReportedPromptTokens = (totals.cacheReportedPromptTokens ?? 0) + usage.promptTokens;
  }
}

export function promptCacheSummary(cached: number | null | undefined, reported: number | null | undefined) {
  if (cached == null || reported == null) return 'Not reported';
  const counts = `${cached.toLocaleString('en-US')} / ${reported.toLocaleString('en-US')}`;
  return reported > 0 ? `${(100 * cached / reported).toFixed(1)}% (${counts})` : counts;
}

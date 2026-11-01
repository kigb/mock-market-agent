import { sqliteTable, text, integer, real, uniqueIndex, index } from 'drizzle-orm/sqlite-core';
export const rooms = sqliteTable('rooms', {
  code: text('code').primaryKey(),
  state: text('state').notNull(),
  version: integer('version').notNull().default(0),
  updatedAt: integer('updated_at').notNull(),
});

export const arenaGames = sqliteTable('arena_games', {
  id: text('id').primaryKey(),
  state: text('state').notNull(),
  version: integer('version').notNull().default(0),
  createdAt: integer('created_at').notNull(),
  // Denormalized from state so a scheduled sweep can finalize due games without parsing every row.
  status: text('status'),
  endsAt: integer('ends_at'),
}, table => [index('arena_games_due').on(table.status, table.endsAt)]);

// One row per model round or self-reported external decision: the three timestamps, latency split, usage, and outcomes.
export const arenaDecisions = sqliteTable('arena_decisions', {
  id: integer('id').primaryKey({autoIncrement:true}),
  gameId: text('game_id').notNull(),
  agentId: text('agent_id').notNull(),
  decisionId: text('decision_id').notNull(),
  round: integer('round').notNull(),
  source: text('source').notNull(),
  provider: text('provider'),
  model: text('model'),
  reasoningEffort: text('reasoning_effort'),
  temperature: real('temperature'),
  maxTokens: integer('max_tokens'),
  observationTime: integer('observation_time'),
  responseTime: integer('response_time'),
  executionTime: integer('execution_time'),
  observationRevision: integer('observation_revision'),
  executionRevision: integer('execution_revision'),
  llmMs: integer('llm_ms'),
  executionMs: integer('execution_ms'),
  stalenessMs: integer('staleness_ms'),
  casRetries: integer('cas_retries'),
  promptTokens: integer('prompt_tokens'),
  completionTokens: integer('completion_tokens'),
  observedBestBid: real('observed_best_bid'),
  observedBestAsk: real('observed_best_ask'),
  executedBestBid: real('executed_best_bid'),
  executedBestAsk: real('executed_best_ask'),
  bookMoved: integer('book_moved'),
  late: integer('late'),
  actions: text('actions'),
  // Visible reasoning the model returned with its tool calls (website agents) or self-reported by external agents.
  note: text('note'),
  // Hidden chain of thought (reasoning_content) kept in full for analysis; never replayed to the model.
  reasoning: text('reasoning'),
  createdAt: integer('created_at').notNull(),
}, table => [uniqueIndex('arena_decisions_receipt').on(table.gameId,table.agentId,table.decisionId,table.round),index('arena_decisions_agent').on(table.gameId,table.agentId,table.id)]);

export const arenaDefaultUsage = sqliteTable('arena_default_usage', {
  day: text('day').primaryKey(),
  calls: integer('calls').notNull().default(0),
});

export const arenaMessages = sqliteTable('arena_messages', {
  id: integer('id').primaryKey({autoIncrement:true}),
  gameId: text('game_id').notNull(),
  agentId: text('agent_id').notNull(),
  decisionId: text('decision_id').notNull(),
  step: integer('step').notNull(),
  message: text('message').notNull(),
  createdAt: integer('created_at').notNull(),
}, table => [uniqueIndex('arena_messages_receipt').on(table.gameId,table.agentId,table.decisionId,table.step),index('arena_messages_agent').on(table.gameId,table.agentId,table.id)]);

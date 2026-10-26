import { sqliteTable, text, integer, uniqueIndex, index } from 'drizzle-orm/sqlite-core';
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
});

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

ALTER TABLE `arena_games` ADD `status` text;--> statement-breakpoint
ALTER TABLE `arena_games` ADD `ends_at` integer;--> statement-breakpoint
CREATE INDEX `arena_games_due` ON `arena_games` (`status`,`ends_at`);--> statement-breakpoint
UPDATE `arena_games` SET `status`=json_extract(`state`,'$.status'), `ends_at`=json_extract(`state`,'$.endsAt');--> statement-breakpoint
CREATE TABLE `arena_decisions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`game_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`decision_id` text NOT NULL,
	`round` integer NOT NULL,
	`source` text NOT NULL,
	`provider` text,
	`model` text,
	`reasoning_effort` text,
	`temperature` real,
	`max_tokens` integer,
	`observation_time` integer,
	`response_time` integer,
	`execution_time` integer,
	`observation_revision` integer,
	`execution_revision` integer,
	`llm_ms` integer,
	`execution_ms` integer,
	`staleness_ms` integer,
	`cas_retries` integer,
	`prompt_tokens` integer,
	`completion_tokens` integer,
	`observed_best_bid` real,
	`observed_best_ask` real,
	`executed_best_bid` real,
	`executed_best_ask` real,
	`book_moved` integer,
	`late` integer,
	`actions` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `arena_decisions_receipt` ON `arena_decisions` (`game_id`,`agent_id`,`decision_id`,`round`);--> statement-breakpoint
CREATE INDEX `arena_decisions_agent` ON `arena_decisions` (`game_id`,`agent_id`,`id`);

CREATE TABLE `arena_messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`game_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`decision_id` text NOT NULL,
	`step` integer NOT NULL,
	`message` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `arena_messages_receipt` ON `arena_messages` (`game_id`,`agent_id`,`decision_id`,`step`);--> statement-breakpoint
CREATE INDEX `arena_messages_agent` ON `arena_messages` (`game_id`,`agent_id`,`id`);
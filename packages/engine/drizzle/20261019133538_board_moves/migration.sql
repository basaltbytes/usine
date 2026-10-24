CREATE TABLE `usine_board_moves` (
	`move_id` integer PRIMARY KEY AUTOINCREMENT,
	`repository` text NOT NULL,
	`item_key` text NOT NULL,
	`moved_at` text NOT NULL,
	`from_lane` text NOT NULL,
	`to_lane` text NOT NULL,
	`added_json` text NOT NULL,
	`removed_json` text NOT NULL,
	CONSTRAINT "usine_board_moves_added_json_valid" CHECK(json_valid("added_json")),
	CONSTRAINT "usine_board_moves_removed_json_valid" CHECK(json_valid("removed_json"))
);
--> statement-breakpoint
CREATE INDEX `usine_board_moves_item` ON `usine_board_moves` (`item_key`,`moved_at`);
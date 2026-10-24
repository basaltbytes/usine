CREATE TABLE `usine_cycle_ask_closures` (
	`ask_id` text PRIMARY KEY,
	`item_key` text NOT NULL,
	`reason` text NOT NULL,
	`ask_json` text NOT NULL,
	`closed_at` text NOT NULL,
	CONSTRAINT `fk_usine_cycle_ask_closures_item_key_usine_item_cycle_budgets_item_key_fk` FOREIGN KEY (`item_key`) REFERENCES `usine_item_cycle_budgets`(`item_key`),
	CONSTRAINT "usine_cycle_ask_closures_reason" CHECK("reason" in ('ItemClosed')),
	CONSTRAINT "usine_cycle_ask_closures_ask_json" CHECK(json_valid("ask_json"))
);

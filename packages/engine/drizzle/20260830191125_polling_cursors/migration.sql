CREATE TABLE `usine_cursors` (
	`cursor_key` text PRIMARY KEY,
	`value_json` text NOT NULL,
	CONSTRAINT "usine_cursors_value_json_valid" CHECK(json_valid("value_json"))
);

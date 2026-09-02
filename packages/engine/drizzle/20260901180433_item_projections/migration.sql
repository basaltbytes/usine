CREATE TABLE `usine_item_projections` (
	`item_key` text PRIMARY KEY,
	`repository` text NOT NULL,
	`source` text NOT NULL,
	`item_number` integer NOT NULL,
	`content_hash` text NOT NULL,
	`payload_json` text NOT NULL,
	CONSTRAINT "usine_item_projections_number" CHECK("item_number" >= 1),
	CONSTRAINT "usine_item_projections_payload_json_valid" CHECK(json_valid("payload_json"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `usine_item_projection_number` ON `usine_item_projections` (`repository`,`item_number`);--> statement-breakpoint
CREATE INDEX `usine_item_projection_repository` ON `usine_item_projections` (`repository`,`item_number`);--> statement-breakpoint
CREATE TRIGGER `usine_projection_items_insert` AFTER INSERT ON `usine_item_projections` BEGIN
	UPDATE `usine_projection_revision` SET `revision` = `revision` + 1 WHERE `singleton` = 1;
END;--> statement-breakpoint
CREATE TRIGGER `usine_projection_items_update` AFTER UPDATE ON `usine_item_projections` BEGIN
	UPDATE `usine_projection_revision` SET `revision` = `revision` + 1 WHERE `singleton` = 1;
END;--> statement-breakpoint
CREATE TRIGGER `usine_projection_items_delete` AFTER DELETE ON `usine_item_projections` BEGIN
	UPDATE `usine_projection_revision` SET `revision` = `revision` + 1 WHERE `singleton` = 1;
END;

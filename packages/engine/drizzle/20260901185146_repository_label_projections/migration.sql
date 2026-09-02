CREATE TABLE `usine_repository_label_projections` (
	`repository` text PRIMARY KEY,
	`labels_json` text NOT NULL,
	CONSTRAINT "usine_repository_label_projections_labels_json_valid" CHECK(json_valid("labels_json"))
);
--> statement-breakpoint
CREATE TRIGGER `usine_projection_repository_labels_insert` AFTER INSERT ON `usine_repository_label_projections` BEGIN
	UPDATE `usine_projection_revision` SET `revision` = `revision` + 1 WHERE `singleton` = 1;
END;
--> statement-breakpoint
CREATE TRIGGER `usine_projection_repository_labels_update` AFTER UPDATE ON `usine_repository_label_projections` BEGIN
	UPDATE `usine_projection_revision` SET `revision` = `revision` + 1 WHERE `singleton` = 1;
END;
--> statement-breakpoint
CREATE TRIGGER `usine_projection_repository_labels_delete` AFTER DELETE ON `usine_repository_label_projections` BEGIN
	UPDATE `usine_projection_revision` SET `revision` = `revision` + 1 WHERE `singleton` = 1;
END;

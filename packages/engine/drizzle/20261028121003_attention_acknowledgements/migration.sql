CREATE TABLE `usine_attention_acknowledgements` (
	`id` text NOT NULL,
	`revision` text NOT NULL,
	`dismissed_by` text,
	`dismissed_at` text NOT NULL,
	CONSTRAINT `usine_attention_acknowledgements_pk` PRIMARY KEY(`id`, `revision`)
);

--> statement-breakpoint
CREATE TRIGGER `usine_projection_attention_insert` AFTER INSERT ON `usine_attention_acknowledgements` BEGIN
  UPDATE `usine_projection_revision` SET `revision` = `revision` + 1 WHERE `singleton` = 1;
END;

--> statement-breakpoint
CREATE TRIGGER `usine_projection_attention_update` AFTER UPDATE ON `usine_attention_acknowledgements` BEGIN
  UPDATE `usine_projection_revision` SET `revision` = `revision` + 1 WHERE `singleton` = 1;
END;

--> statement-breakpoint
CREATE TRIGGER `usine_projection_attention_delete` AFTER DELETE ON `usine_attention_acknowledgements` BEGIN
  UPDATE `usine_projection_revision` SET `revision` = `revision` + 1 WHERE `singleton` = 1;
END;

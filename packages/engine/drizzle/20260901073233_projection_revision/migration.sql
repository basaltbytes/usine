CREATE TABLE `usine_projection_revision` (
	`singleton` integer PRIMARY KEY DEFAULT 1,
	`revision` integer DEFAULT 0 NOT NULL,
	CONSTRAINT "usine_projection_revision_singleton" CHECK("singleton" = 1)
);
--> statement-breakpoint
INSERT INTO `usine_projection_revision` (`singleton`, `revision`) VALUES (1, 0);
--> statement-breakpoint
CREATE TRIGGER `usine_projection_runs_insert` AFTER INSERT ON `usine_runs` BEGIN
	UPDATE `usine_projection_revision` SET `revision` = `revision` + 1 WHERE `singleton` = 1;
END;
--> statement-breakpoint
CREATE TRIGGER `usine_projection_runs_update` AFTER UPDATE ON `usine_runs` BEGIN
	UPDATE `usine_projection_revision` SET `revision` = `revision` + 1 WHERE `singleton` = 1;
END;
--> statement-breakpoint
CREATE TRIGGER `usine_projection_runs_delete` AFTER DELETE ON `usine_runs` BEGIN
	UPDATE `usine_projection_revision` SET `revision` = `revision` + 1 WHERE `singleton` = 1;
END;
--> statement-breakpoint
CREATE TRIGGER `usine_projection_steps_insert` AFTER INSERT ON `usine_steps` BEGIN
	UPDATE `usine_projection_revision` SET `revision` = `revision` + 1 WHERE `singleton` = 1;
END;
--> statement-breakpoint
CREATE TRIGGER `usine_projection_steps_update` AFTER UPDATE ON `usine_steps` BEGIN
	UPDATE `usine_projection_revision` SET `revision` = `revision` + 1 WHERE `singleton` = 1;
END;
--> statement-breakpoint
CREATE TRIGGER `usine_projection_steps_delete` AFTER DELETE ON `usine_steps` BEGIN
	UPDATE `usine_projection_revision` SET `revision` = `revision` + 1 WHERE `singleton` = 1;
END;
--> statement-breakpoint
CREATE TRIGGER `usine_projection_attempts_insert` AFTER INSERT ON `usine_attempts` BEGIN
	UPDATE `usine_projection_revision` SET `revision` = `revision` + 1 WHERE `singleton` = 1;
END;
--> statement-breakpoint
CREATE TRIGGER `usine_projection_attempts_update` AFTER UPDATE ON `usine_attempts` BEGIN
	UPDATE `usine_projection_revision` SET `revision` = `revision` + 1 WHERE `singleton` = 1;
END;
--> statement-breakpoint
CREATE TRIGGER `usine_projection_attempts_delete` AFTER DELETE ON `usine_attempts` BEGIN
	UPDATE `usine_projection_revision` SET `revision` = `revision` + 1 WHERE `singleton` = 1;
END;
--> statement-breakpoint
CREATE TRIGGER `usine_projection_loop_runtime_insert` AFTER INSERT ON `usine_loop_runtime` BEGIN
	UPDATE `usine_projection_revision` SET `revision` = `revision` + 1 WHERE `singleton` = 1;
END;
--> statement-breakpoint
CREATE TRIGGER `usine_projection_loop_runtime_update` AFTER UPDATE ON `usine_loop_runtime` BEGIN
	UPDATE `usine_projection_revision` SET `revision` = `revision` + 1 WHERE `singleton` = 1;
END;
--> statement-breakpoint
CREATE TRIGGER `usine_projection_loop_runtime_delete` AFTER DELETE ON `usine_loop_runtime` BEGIN
	UPDATE `usine_projection_revision` SET `revision` = `revision` + 1 WHERE `singleton` = 1;
END;

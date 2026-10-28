CREATE TABLE `usine_configuration_entities` (
	`key` text PRIMARY KEY,
	`position` integer NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `usine_configuration_revisions` (
	`number` integer PRIMARY KEY,
	`value` text NOT NULL
);

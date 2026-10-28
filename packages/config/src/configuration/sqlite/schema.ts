import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const configurationEntitiesTable = sqliteTable("usine_configuration_entities", {
  key: text("key").primaryKey(),
  position: integer("position").notNull(),
  value: text("value").notNull(),
});

export const configurationRevisionsTable = sqliteTable("usine_configuration_revisions", {
  number: integer("number").primaryKey(),
  value: text("value").notNull(),
});

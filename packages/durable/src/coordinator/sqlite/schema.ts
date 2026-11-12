import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** One row per Attempt. JSON columns hold Schema-encoded values. */
export const coordinationTable = sqliteTable("usine_attempt_coordination", {
  attemptId: text("attempt_id").primaryKey(),
  request: text("request").notNull(),
  revision: integer("revision").notNull(),
  state: text("state"),
  status: text("status").notNull(),
  nextOutbound: integer("next_outbound").notNull(),
  result: text("result"),
  unsupervisedMillis: integer("unsupervised_millis"),
  nextInbound: integer("next_inbound").notNull().default(1),
});

/** The ledger. A row without an event holds a decision whose transition hasn't committed. */
export const eventsTable = sqliteTable(
  "usine_attempt_events",
  {
    attemptId: text("attempt_id")
      .notNull()
      .references(() => coordinationTable.attemptId),
    sequence: integer("sequence").notNull(),
    event: text("event"),
    decision: text("decision").notNull(),
  },
  (table) => [primaryKey({ columns: [table.attemptId, table.sequence] })],
);

export const delegationsTable = sqliteTable(
  "usine_attempt_delegations",
  {
    attemptId: text("attempt_id")
      .notNull()
      .references(() => coordinationTable.attemptId),
    number: integer("number").notNull(),
    delegation: text("delegation").notNull(),
    /** Null until a run of the delegation starts its child. */
    progress: text("progress"),
    outcome: text("outcome"),
  },
  (table) => [primaryKey({ columns: [table.attemptId, table.number] })],
);

export const outboxTable = sqliteTable(
  "usine_attempt_outbox",
  {
    attemptId: text("attempt_id")
      .notNull()
      .references(() => coordinationTable.attemptId),
    sequence: integer("sequence").notNull(),
    envelope: text("envelope").notNull(),
  },
  (table) => [primaryKey({ columns: [table.attemptId, table.sequence] })],
);

/** The children that the operator holds or pauses. A child with neither has no row. */
export const supervisionTable = sqliteTable(
  "usine_attempt_supervision",
  {
    attemptId: text("attempt_id")
      .notNull()
      .references(() => coordinationTable.attemptId),
    sessionId: text("session_id").notNull(),
    held: integer("held", { mode: "boolean" }).notNull(),
    paused: integer("paused", { mode: "boolean" }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.attemptId, table.sessionId] })],
);

/** Operator inputs that children queued and haven't reported read or unread. */
export const inputsTable = sqliteTable(
  "usine_attempt_inputs",
  {
    attemptId: text("attempt_id")
      .notNull()
      .references(() => coordinationTable.attemptId),
    sequence: integer("sequence").notNull(),
    sessionId: text("session_id").notNull(),
    intervention: text("intervention").notNull(),
  },
  (table) => [primaryKey({ columns: [table.attemptId, table.sequence] })],
);

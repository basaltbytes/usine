import type { RecordChange } from "../changes.ts";
import { changeRecorder } from "../changes.ts";
import type { RunDatabaseClient } from "../../database/database.ts";
import { cycleQueries } from "../../cycle-budget/queries.ts";
import type { TranscriptCodec } from "../transcript/codec.ts";
import { transcriptQueries } from "../transcript/queries.ts";
import { attemptQueries } from "./attempts.ts";
import { eventQueries } from "./events.ts";
import { loopItemQueries } from "./loop-items.ts";
import { queueQueries } from "./queue.ts";
import { runQueries } from "./runs.ts";

/** Returns the Run store queries that run on the caller's transaction. */
export const queriesFor = (
  database: RunDatabaseClient,
  codec: TranscriptCodec["Service"],
  record?: RecordChange,
) => ({
  changedAttempt: changeRecorder(database, record).changedAttempt,
  cycles: cycleQueries(database, record),
  loopItems: loopItemQueries(database),
  ...transcriptQueries(database, codec),
  ...attemptQueries(database, record),
  ...runQueries(database, record),
  ...eventQueries(database),
  ...queueQueries(database, record),
});

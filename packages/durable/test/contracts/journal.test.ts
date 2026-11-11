import { attemptJournalContract, attemptJournalWriteFailureContract } from "./attempt-journal.ts";
import { memoryAdapter } from "./memory.ts";
import { sqliteAdapter } from "./sqlite.ts";

for (const adapter of [memoryAdapter, sqliteAdapter]) attemptJournalContract(adapter);
attemptJournalWriteFailureContract(sqliteAdapter);

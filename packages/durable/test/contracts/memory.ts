import { Effect, Layer } from "effect";

import { memoryAttemptJournalLayer } from "../../src/coordinator/memory.ts";
import type { JournalAdapter } from "./adapter.ts";

/** Reopening returns the same in-memory journal, as a process that never restarted would. */
export const memoryAdapter: JournalAdapter = {
  name: "memory",
  fixture: Layer.build(memoryAttemptJournalLayer).pipe(
    Effect.map((context) => ({ open: Layer.succeedContext(context) })),
  ),
};

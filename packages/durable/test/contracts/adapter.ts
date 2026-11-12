import type { Effect, Layer, Scope } from "effect";

import type { AttemptJournal } from "../../src/coordinator/journal.ts";

export interface JournalFixture {
  /** Opens the same journal in a fresh scope, preserving committed records. */
  readonly open: Layer.Layer<AttemptJournal>;
}

/** A fixture whose storage can fail a write in the middle of a transaction. */
export interface FailingJournalFixture extends JournalFixture {
  /** Makes every outbox insert fail until the returned effect runs. */
  readonly rejectOutboxInsert: Effect.Effect<Effect.Effect<void>>;
}

export interface JournalAdapter<Fixture extends JournalFixture = JournalFixture> {
  readonly name: string;
  /** Allocates isolated storage and removes it after the test. */
  readonly fixture: Effect.Effect<Fixture, never, Scope.Scope>;
}

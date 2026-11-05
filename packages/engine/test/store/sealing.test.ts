import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { AttemptId } from "@usine/core/attempt";
import * as AttemptChannel from "@usine/core/attempt/channel";
import {
  AgentSessionId,
  ParentSession,
  ChildSession,
  PoolRateLimitsUpdated,
  RateLimitsSnapshot,
  SessionStarted,
  SessionIdle,
  SessionFinished,
  SessionTokensUpdated,
  TextOutput,
  TokenCount,
} from "@usine/core/agent/session";
import { InstanceDirectory } from "@usine/core/instance";
import { RunId } from "@usine/core/run";
import { WorkerName } from "@usine/core/worker";
import { eq } from "drizzle-orm";
import {
  Array as EffectArray,
  DateTime,
  Effect,
  FileSystem,
  Layer,
  Logger,
  Option,
  PlatformError,
  Ref,
  Schedule,
  Path,
  Schema,
} from "effect";
import { SqlClient } from "effect/sql";
import { sqliteTempDirectory } from "../../../../tooling/test/sqlite.mts";
import { RunDatabase } from "../../src/database/database.ts";
import { backup, localSqliteLayer, runReaderLayer } from "../../src/database/local-sqlite.ts";
import {
  attemptTranscripts,
  attempts,
  transcriptSegments,
  transcriptSeals,
} from "../../src/database/schema.ts";
import { RunReader } from "../../src/run-reader/run-reader.ts";
import { RunStore } from "../../src/store/store.ts";
import { TranscriptCodec } from "../../src/store/transcript/codec.ts";
import { TranscriptSealer, transcriptSealerLayer } from "../../src/store/transcript/sealer.ts";
import {
  TranscriptAllQuery,
  TranscriptPageQuery,
  TranscriptTailQuery,
  TranscriptSessionsQuery,
  TranscriptWorkerQuery,
  TranscriptUsageQuery,
  type TranscriptSequence,
  type TranscriptEntry,
} from "../../src/transcript.ts";
import { type AttemptPlan, engineLayer, executorLayer, submission } from "../support.ts";
import { lifecycleSubmission, testAgent } from "./support.ts";

const at = DateTime.makeUnsafe("2026-10-01T00:00:00Z");
const parent = ParentSession.make({
  id: AgentSessionId.make("sealed-parent"),
  agent: testAgent.name,
  brain: testAgent.brain,
});
const envelope = (
  attemptId: AttemptId,
  sequence: number,
  payload: AttemptChannel.OutboundPayload = AttemptChannel.SessionEvent.make({
    event: TextOutput.make({ session: parent, text: `message ${sequence}` }),
  }),
) =>
  AttemptChannel.OutboundEnvelope.make({
    version: AttemptChannel.PROTOCOL_VERSION,
    attemptId,
    sequence: AttemptChannel.Sequence.make(sequence),
    sentAt: at,
    payload,
  });

const start = Effect.gen(function* () {
  const store = yield* RunStore;
  const runId = RunId.make("sealing-run");
  yield* store.recordAndClaim(lifecycleSubmission, runId);
  const started = yield* store.beginAttempt(runId, WorkerName.make("local"), Option.none());
  assert(started._tag === "AttemptStarted");
  return { runId, attemptId: started.execution.attempt.id };
});
const end = (runId: RunId, attemptId: AttemptId) =>
  Effect.gen(function* () {
    const store = yield* RunStore;
    const db = yield* RunDatabase;
    yield* store.cancel(runId);
    yield* db
      .update(attempts)
      .set({ endedAt: DateTime.formatIso(at) })
      .where(eq(attempts.attemptId, attemptId))
      .execute();
  });
const withSealing = <A, E>(
  test: (
    directory: InstanceDirectory,
  ) => Effect.Effect<
    A,
    E,
    | RunStore
    | RunReader
    | RunDatabase
    | TranscriptCodec
    | TranscriptSealer
    | SqlClient.SqlClient
    | FileSystem.FileSystem
    | Path.Path
  >,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const temporary = yield* fs.makeTempDirectoryScoped({
      directory: sqliteTempDirectory(),
      prefix: "usine-sealing-",
    });
    const directory = InstanceDirectory.make(temporary);
    const database = transcriptSealerLayer.pipe(Layer.provideMerge(localSqliteLayer(directory)));
    return yield* test(directory).pipe(
      Effect.provide(
        Layer.merge(RunReader.layer, RunStore.layer).pipe(Layer.provideMerge(database)),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe("SQLite transcript sealing", () => {
  it.live(
    "preserves pages, sessions, usage, evidence and late envelopes through sealing and compact backup",
    () =>
      withSealing((directory) =>
        Effect.gen(function* () {
          const store = yield* RunStore;
          const reader = yield* RunReader;
          const db = yield* RunDatabase;
          const sealer = yield* TranscriptSealer;
          const fs = yield* FileSystem.FileSystem;
          const { runId, attemptId } = yield* start;
          const events = [
            SessionStarted.make({ session: parent }),
            SessionIdle.make({ session: parent }),
            SessionFinished.make({ session: parent }),
            SessionTokensUpdated.make({ session: parent, totalTokens: TokenCount.make(42) }),
            PoolRateLimitsUpdated.make({
              session: parent,
              pool: "chatgptPlan",
              rateLimits: RateLimitsSnapshot.make({
                limitId: Option.none(),
                limitName: Option.none(),
                primary: Option.none(),
                secondary: Option.none(),
              }),
            }),
          ];
          for (const [index, event] of events.entries())
            yield* store.appendTranscript(
              "outbound",
              envelope(attemptId, index + 1, AttemptChannel.SessionEvent.make({ event })),
            );
          yield* store.appendTranscript(
            "outbound",
            envelope(
              attemptId,
              6,
              AttemptChannel.WorkerResponsive.make({
                worker: WorkerName.make("local"),
                lastAnsweredAt: at,
              }),
            ),
          );
          const input = AttemptChannel.InboundEnvelope.make({
            version: AttemptChannel.PROTOCOL_VERSION,
            attemptId,
            sequence: AttemptChannel.Sequence.make(1),
            sentAt: at,
            target: AttemptChannel.ParentTarget.make(),
            operator: "operator",
            payload: AttemptChannel.Interrupt.make(),
          });
          yield* store.appendTranscript("inbound", input);
          const child = ChildSession.make({
            id: AgentSessionId.make("sealed-child"),
            parentId: parent.id,
            agent: testAgent.name,
            brain: testAgent.brain,
          });
          const intervention = AttemptChannel.Intervention.make({
            operator: "operator",
            target: AttemptChannel.ParentTarget.make(),
            action: AttemptChannel.Interrupt.make(),
          });
          const payloads = new Map<number, AttemptChannel.OutboundPayload>([
            [
              111,
              AttemptChannel.SessionEvent.make({ event: SessionStarted.make({ session: child }) }),
            ],
            [
              112,
              AttemptChannel.SessionEvent.make({ event: SessionIdle.make({ session: child }) }),
            ],
            [
              511,
              AttemptChannel.SessionEvent.make({ event: SessionFinished.make({ session: child }) }),
            ],
            [
              499,
              AttemptChannel.InterventionApplied.make({
                inputSequence: AttemptChannel.Sequence.make(1),
                intervention,
                state: AttemptChannel.InterventionState.make({ held: false, paused: true }),
              }),
            ],
            [
              501,
              AttemptChannel.InterventionRejected.make({
                inputSequence: AttemptChannel.Sequence.make(1),
                intervention,
                message: "Session finished",
              }),
            ],
          ]);
          // Sparse append positions exercise range selection independently of channel sequences.
          const rows = yield* Effect.forEach(EffectArray.range(7, 1010), (sequence) =>
            Effect.gen(function* () {
              const encoded = yield* Schema.encodeEffect(AttemptChannel.Envelope)(
                envelope(attemptId, sequence, payloads.get(sequence)),
              );
              return {
                sequence: sequence * 3,
                attemptId,
                direction: "outbound" as const,
                channelSequence: AttemptChannel.Sequence.make(sequence),
                receivedAt: DateTime.formatIso(at),
                envelope: { ...encoded, version: 3 + (sequence % 5) },
              };
            }),
          );
          for (const chunk of EffectArray.chunksOf(rows, 100))
            yield* db.insert(attemptTranscripts).values(chunk).execute();
          yield* end(runId, attemptId);
          const all = yield* reader.transcript(TranscriptAllQuery.make({ attemptId }));
          const sessionsQuery = TranscriptSessionsQuery.make({ attemptId });
          const workerQuery = TranscriptWorkerQuery.make({ attemptId });
          const usageQuery = TranscriptUsageQuery.make({ attemptId });
          const sessions = yield* reader.transcript(sessionsQuery);
          const worker = yield* reader.transcript(workerQuery);
          const usage = yield* reader.transcript(usageQuery);
          const pools = yield* reader.latestPoolRateLimits;
          const evidence = yield* reader.evidence(runId);
          const sealed = yield* sealer.sealNext;
          assert.strictEqual(sealed, true);
          const hotRowsAfterSealing = yield* db.$count(attemptTranscripts).execute();
          assert.strictEqual(hotRowsAfterSealing, 0);
          const segmentSizes = (yield* db
            .select({ rows: transcriptSegments.rows })
            .from(transcriptSegments)
            .execute()).map(({ rows }) => rows);
          assert.deepStrictEqual(segmentSizes, [500, 500, 11]);
          const sealedEntries = yield* reader.transcript(TranscriptAllQuery.make({ attemptId }));
          assert.deepStrictEqual(sealedEntries, all);
          const codec = yield* TranscriptCodec;
          const isolatedEntries = yield* Effect.flatMap(RunReader, (reader) =>
            reader.transcript(TranscriptAllQuery.make({ attemptId })),
          ).pipe(
            Effect.provide(
              Layer.fresh(RunReader.layer).pipe(
                Layer.provide(
                  Layer.merge(RunDatabase.layer(db), Layer.succeed(TranscriptCodec)(codec)),
                ),
              ),
            ),
          );
          assert.deepStrictEqual(isolatedEntries, all);
          const sealedSessions = yield* reader.transcript(sessionsQuery);
          assert.deepStrictEqual(sealedSessions, sessions);
          const sealedWorker = yield* reader.transcript(workerQuery);
          assert.deepStrictEqual(sealedWorker, worker);
          const sealedUsage = yield* reader.transcript(usageQuery);
          assert.deepStrictEqual(sealedUsage, usage);
          const sealedPools = yield* reader.latestPoolRateLimits;
          assert.deepStrictEqual(sealedPools, pools);
          const sealedEvidence = yield* reader.evidence(runId);
          assert.deepStrictEqual(sealedEvidence, evidence);
          for (const limit of [1, 37, 500, 1500]) {
            let before = Option.none<TranscriptSequence>();
            const pages: Array<TranscriptEntry> = [];
            while (true) {
              const page = yield* store.transcript(
                TranscriptPageQuery.make({ attemptId, before, limit }),
              );
              const first = page[0];
              if (first === undefined) break;
              pages.unshift(...page);
              before = Option.some(first.sequence);
            }
            assert.deepStrictEqual(pages, all);
            for (const entry of all.filter((_, index) => index % 113 === 0)) {
              const tailEntries = yield* reader.transcript(
                TranscriptTailQuery.make({ attemptId, after: entry.sequence, limit }),
              );
              assert.deepStrictEqual(
                tailEntries,
                all.filter(({ sequence }) => sequence > entry.sequence).slice(0, limit),
              );
            }
          }
          yield* store.appendTranscript("outbound", envelope(attemptId, 1));
          yield* store.appendTranscript("inbound", input);
          const redeliveredHotRows = yield* db.$count(attemptTranscripts).execute();
          assert.strictEqual(redeliveredHotRows, 0);
          yield* store.appendTranscript(
            "outbound",
            envelope(
              attemptId,
              1011,
              AttemptChannel.SessionEvent.make({ event: SessionIdle.make({ session: parent }) }),
            ),
          );
          yield* store.appendTranscript("outbound", envelope(attemptId, 1011));
          yield* store.appendTranscript(
            "inbound",
            AttemptChannel.InboundEnvelope.make({
              ...input,
              sequence: AttemptChannel.Sequence.make(2),
            }),
          );
          const late = yield* reader.transcript(TranscriptAllQuery.make({ attemptId }));
          assert.deepStrictEqual(late.slice(0, all.length), all);
          assert.strictEqual(late.length, all.length + 2);
          const lateSessions = yield* reader.transcript(sessionsQuery);
          const latestSession = lateSessions.at(-1);
          assert(latestSession !== undefined);
          assert.strictEqual(latestSession.envelope.payload._tag, "SessionEvent");
          if (latestSession.envelope.payload._tag === "SessionEvent")
            assert.strictEqual(latestSession.envelope.payload.event._tag, "SessionIdle");
          for (const limit of [1, 2, 5, 700]) {
            const latePage = yield* reader.transcript(
              TranscriptPageQuery.make({ attemptId, before: Option.none(), limit }),
            );
            assert.deepStrictEqual(latePage, late.slice(-limit));
          }
          const allLast = all.at(-1);
          assert(allLast !== undefined);
          const lateTail = yield* reader.transcript(
            TranscriptTailQuery.make({ attemptId, after: allLast.sequence, limit: 20 }),
          );
          assert.deepStrictEqual(lateTail, late.slice(all.length));
          const sql = yield* SqlClient.SqlClient;
          yield* sql`CREATE TABLE backup_padding (body BLOB)`;
          yield* sql`INSERT INTO backup_padding VALUES (zeroblob(2000000))`;
          yield* sql`DELETE FROM backup_padding`;
          yield* sql`PRAGMA wal_checkpoint(TRUNCATE)`;
          const destination = `${directory}/backup.sqlite`;
          yield* backup(directory, destination);
          const originalSize = (yield* fs.stat(`${directory}/.usine/runtime.sqlite`)).size;
          const compactSize = (yield* fs.stat(destination)).size;
          assert.isBelow(Number(compactSize), Number(originalSize));
          const restored = InstanceDirectory.make(`${directory}/restored`);
          yield* fs.makeDirectory(`${restored}/.usine`, { recursive: true });
          yield* fs.copyFile(destination, `${restored}/.usine/runtime.sqlite`);
          yield* Effect.gen(function* () {
            const restoredReader = yield* RunReader;
            const restoredEvidence = yield* restoredReader.evidence(runId);
            const currentEvidence = yield* reader.evidence(runId);
            assert.deepStrictEqual(restoredEvidence, currentEvidence);
          }).pipe(Effect.provide(runReaderLayer(restored)));
          const noMoreCandidates = yield* sealer.sealNext;
          assert.strictEqual(noMoreCandidates, false);
          const oldest = all[0];
          const boundary = all[999];
          assert(oldest !== undefined && boundary !== undefined);
          yield* db
            .update(transcriptSegments)
            .set({ body: new Uint8Array([0]) })
            .where(eq(transcriptSegments.firstSequence, oldest.sequence))
            .execute();
          const tail = yield* reader.transcript(
            TranscriptTailQuery.make({ attemptId, after: boundary.sequence, limit: 5 }),
          );
          assert.deepStrictEqual(
            tail,
            late.filter(({ sequence }) => sequence > boundary.sequence).slice(0, 5),
          );
          const page = yield* reader.transcript(
            TranscriptPageQuery.make({
              attemptId,
              before: Option.some(allLast.sequence),
              limit: 5,
            }),
          );
          assert.deepStrictEqual(page, all.slice(-6, -1));
          const corrupt = yield* reader
            .transcript(TranscriptAllQuery.make({ attemptId }))
            .pipe(Effect.flip);
          assert.strictEqual(corrupt._tag, "EnginePersistenceError");
        }),
      ),
    { timeout: 60_000 },
  );

  it.live(
    "aborts a seal if an envelope arrives during compression, and retries on the next pass",
    () =>
      withSealing(() =>
        Effect.gen(function* () {
          const store = yield* RunStore;
          const db = yield* RunDatabase;
          const codec = yield* TranscriptCodec;
          const { runId, attemptId } = yield* start;
          yield* store.appendTranscript("outbound", envelope(attemptId, 1));
          yield* end(runId, attemptId);
          const changed = Layer.succeed(TranscriptCodec)({
            ...codec,
            compress: (text) =>
              store
                .appendTranscript("outbound", envelope(attemptId, 2))
                .pipe(Effect.orDie, Effect.andThen(codec.compress(text))),
          });
          yield* Effect.gen(function* () {
            const sealer = yield* TranscriptSealer;
            yield* sealer.sealNext;
            const sealsAfterRace = yield* db.$count(transcriptSeals).execute();
            assert.strictEqual(sealsAfterRace, 0);
            const segmentsAfterRace = yield* db.$count(transcriptSegments).execute();
            assert.strictEqual(segmentsAfterRace, 0);
            const hotRowsAfterRace = yield* db.$count(attemptTranscripts).execute();
            assert.strictEqual(hotRowsAfterRace, 2);
            yield* sealer.sealNext;
            yield* sealer.sealNext;
            const sealsAfterRetry = yield* db.$count(transcriptSeals).execute();
            assert.strictEqual(sealsAfterRetry, 1);
            const entriesAfterRetry = yield* store.transcript(
              TranscriptAllQuery.make({ attemptId }),
            );
            assert.lengthOf(entriesAfterRetry, 2);
          }).pipe(Effect.provide(Layer.fresh(transcriptSealerLayer).pipe(Layer.provide(changed))));
        }),
      ),
  );

  it.live("keeps open and recent attempts hot and seals legacy outcomes without an end time", () =>
    withSealing(() =>
      Effect.gen(function* () {
        const store = yield* RunStore;
        const db = yield* RunDatabase;
        const sealer = yield* TranscriptSealer;
        const { runId, attemptId } = yield* start;
        yield* db
          .update(attempts)
          .set({ startedAt: DateTime.formatIso(at) })
          .execute();
        yield* store.appendTranscript("outbound", envelope(attemptId, 1));
        const openCandidate = yield* sealer.sealNext;
        assert.strictEqual(openCandidate, false);
        yield* store.cancel(runId);
        const recentCandidate = yield* sealer.sealNext;
        assert.strictEqual(recentCandidate, false);
        yield* db.update(attempts).set({ endedAt: null }).execute();
        const legacyCandidate = yield* sealer.sealNext;
        assert.strictEqual(legacyCandidate, true);
        const legacyHotRows = yield* db.$count(attemptTranscripts).execute();
        assert.strictEqual(legacyHotRows, 0);
      }),
    ),
  );

  it.live("identifies malformed rows, keeps them hot, and skips them on subsequent passes", () =>
    withSealing(() =>
      Effect.gen(function* () {
        const store = yield* RunStore;
        const sealer = yield* TranscriptSealer;
        const sql = yield* SqlClient.SqlClient;
        const db = yield* RunDatabase;
        const { runId, attemptId } = yield* start;
        yield* store.appendTranscript("outbound", envelope(attemptId, 1));
        yield* end(runId, attemptId);
        // Simulate a malformed persisted row at the storage boundary.
        yield* sql`UPDATE usine_attempt_transcripts SET channel_sequence = 1.5 WHERE attempt_id = ${attemptId}`;
        const warnings: Array<unknown> = [];
        const logger = Logger.make(({ logLevel, message }) => {
          if (logLevel === "Warn") warnings.push(message);
        });
        yield* Effect.gen(function* () {
          const error = yield* sealer.sealNext.pipe(Effect.flip);
          assert.strictEqual(error._tag, "EnginePersistenceError");
          const healthyRun = RunId.make("healthy-sealing-run");
          yield* store.recordAndClaim(submission({ number: 2 }), healthyRun);
          const healthy = yield* store.beginAttempt(
            healthyRun,
            WorkerName.make("local"),
            Option.none(),
          );
          assert(healthy._tag === "AttemptStarted");
          yield* store.appendTranscript("outbound", envelope(healthy.execution.attempt.id, 1));
          yield* end(healthyRun, healthy.execution.attempt.id);
          yield* sealer.sealNext;
          yield* sealer.sealNext;
          const passEnd = yield* sealer.sealNext;
          const nextPass = yield* sealer.sealNext;
          assert.isFalse(passEnd);
          assert.isFalse(nextPass);
        }).pipe(Effect.provide(Logger.layer([logger])));
        assert.lengthOf(warnings, 1);
        const warning = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
          warnings[0],
        );
        assert.include(warning, attemptId);
        assert.include(warning, "channelSequence");
        assert.include(warning, "after restart");
        assert.notInclude(warning, "message 1");
        const hotRows = yield* db.$count(attemptTranscripts).execute();
        const seals = yield* db.$count(transcriptSeals).execute();
        assert.strictEqual(hotRows, 1);
        assert.strictEqual(seals, 1);
      }),
    ),
  );

  it.live("starts transcript maintenance from the local SQLite runtime", () =>
    withSealing((directory) =>
      Effect.gen(function* () {
        const store = yield* RunStore;
        const db = yield* RunDatabase;
        const { runId, attemptId } = yield* start;
        yield* store.appendTranscript("outbound", envelope(attemptId, 1));
        yield* end(runId, attemptId);
        const plans = yield* Ref.make<ReadonlyArray<AttemptPlan>>([]);
        const seals = yield* Effect.scoped(
          db
            .$count(transcriptSeals)
            .execute()
            .pipe(
              Effect.repeat({
                while: (count) => count === 0,
                schedule: Schedule.spaced("10 millis"),
              }),
              Effect.timeout("5 seconds"),
              Effect.provide(engineLayer(directory, executorLayer(plans))),
            ),
        );
        assert.strictEqual(seals, 1);
      }),
    ),
  );

  for (const phase of ["file", "directory"] as const)
    it.live(`reports a ${phase} sync failure before declaring a backup complete`, () =>
      withSealing((directory) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const destination = `${directory}/sync-failure.sqlite`;
          const failure = PlatformError.systemError({
            _tag: "Unknown",
            module: "FileSystem",
            method: "sync",
            pathOrDescriptor: destination,
            description: "sync unavailable",
          });
          const failingFs = FileSystem.make({
            ...fs,
            open: (path, options) =>
              fs.open(path, options).pipe(
                Effect.map((file) => ({
                  ...file,
                  sync: (
                    phase === "directory" ? path === directory : path.endsWith("/runtime.sqlite")
                  )
                    ? Effect.fail(failure)
                    : file.sync,
                })),
              ),
          });
          const error = yield* backup(directory, destination).pipe(
            Effect.provideService(FileSystem.FileSystem, failingFs),
            Effect.flip,
          );
          assert.strictEqual(error._tag, "RuntimeStoreBackupError");
          assert.strictEqual(error.operation, phase === "file" ? "copy" : "publish");
          assert.strictEqual(error.reason, "sync unavailable");
          const published = yield* fs.exists(destination);
          assert.strictEqual(published, phase === "directory");
        }),
      ),
    );

  it.live("rolls back segments and the seal if deleting hot rows fails", () =>
    withSealing(() =>
      Effect.gen(function* () {
        const store = yield* RunStore;
        const db = yield* RunDatabase;
        const sealer = yield* TranscriptSealer;
        const sql = yield* SqlClient.SqlClient;
        const { runId, attemptId } = yield* start;
        yield* store.appendTranscript("outbound", envelope(attemptId, 1));
        yield* end(runId, attemptId);
        yield* sql`CREATE TRIGGER reject_sealing BEFORE DELETE ON usine_attempt_transcripts BEGIN SELECT RAISE(ABORT, 'delete unavailable'); END`;
        const failureTag = (yield* sealer.sealNext.pipe(Effect.flip))._tag;
        assert.strictEqual(failureTag, "EnginePersistenceError");
        const rolledBackSeals = yield* db.$count(transcriptSeals).execute();
        assert.strictEqual(rolledBackSeals, 0);
        const rolledBackSegments = yield* db.$count(transcriptSegments).execute();
        assert.strictEqual(rolledBackSegments, 0);
        const preservedHotRows = yield* db.$count(attemptTranscripts).execute();
        assert.strictEqual(preservedHotRows, 1);
        yield* sql`DROP TRIGGER reject_sealing`;
        yield* sealer.sealNext;
        yield* sealer.sealNext;
        const retriedSeals = yield* db.$count(transcriptSeals).execute();
        assert.strictEqual(retriedSeals, 1);
      }),
    ),
  );
});

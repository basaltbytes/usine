import { CiHandoff } from "@usine/core/ci";
import { ItemNumber } from "@usine/core/item";
import { CommitSha } from "@usine/core/repository";
import { Agent } from "@usine/core/agent";
import {
  AgentSessionId,
  ParentSession,
  PoolRateLimitsUpdated,
  RateLimitsSnapshot,
  SessionStarted,
  SessionTokensUpdated,
  TextOutput,
  TokenCount,
} from "@usine/core/agent/session";
import { AttemptId } from "@usine/core/attempt";
import {
  AttemptAwaitingCi,
  AttemptHandedOff,
  AttemptOutcome,
  AttemptSucceeded,
} from "@usine/core/attempt/outcome";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { RunId } from "@usine/core/run";
import * as RunState from "@usine/core/run/state";
import { DateTime, Effect, Option, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { lifecycleSubmission, testAgent } from "../support.ts";

// Bulk inserts exercise the real persisted JSON codecs without timing 200,000 individual appends.
export const seedReadFixture = Effect.fn("ReadPlans.seedFixture")(function* (padding: number) {
  const sql = yield* SqlClient.SqlClient;
  const at = "2026-11-01T00:00:00.000Z";
  const valueDecoded1 = yield* Schema.encodeEffect(Agent)(testAgent);
  const json1 = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
    valueDecoded1,
  ).pipe(Effect.orDie);
  const agent = json1;
  const valueDecoded2 = yield* Schema.encodeEffect(Agent.fields.brain)(testAgent.brain);
  const json2 = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
    valueDecoded2,
  ).pipe(Effect.orDie);
  const brain = json2;
  const valueDecoded3 = yield* Schema.encodeEffect(RunState.RunState)(RunState.Running.make());
  const json3 = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
    valueDecoded3,
  ).pipe(Effect.orDie);
  const running = json3;
  const valueDecoded4 = yield* Schema.encodeEffect(RunState.RunState)(
    RunState.AwaitingCi.make({
      handoff: CiHandoff.make({
        pullRequest: ItemNumber.make(1),
        head: CommitSha.make("a".repeat(40)),
        fixLoop: lifecycleSubmission.loop,
        timeoutSeconds: 1800,
        onGreen: [],
      }),
    }),
  );
  const json4 = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
    valueDecoded4,
  ).pipe(Effect.orDie);
  const awaitingCi = json4;
  const valueDecoded5 = yield* Schema.encodeEffect(RunState.RunState)(
    RunState.HandedOff.make({
      reason: "CI fix admitted",
      head: CommitSha.make("a".repeat(40)),
      fixLoop: lifecycleSubmission.loop,
      fixRunId: RunId.make("run-989"),
    }),
  );
  const json5 = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
    valueDecoded5,
  ).pipe(Effect.orDie);
  const handedOff = json5;
  const valueDecoded6 = yield* Schema.encodeEffect(RunState.RunState)(RunState.Succeeded.make());
  const json6 = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
    valueDecoded6,
  ).pipe(Effect.orDie);
  const succeeded = json6;
  const valueDecoded7 = yield* Schema.encodeEffect(AttemptOutcome)(AttemptSucceeded.make());
  const json7 = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
    valueDecoded7,
  ).pipe(Effect.orDie);
  const succeededOutcome = json7;
  const valueDecoded8 = yield* Schema.encodeEffect(AttemptOutcome)(AttemptHandedOff.make());
  const json8 = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
    valueDecoded8,
  ).pipe(Effect.orDie);
  const handedOffOutcome = json8;
  const valueDecoded9 = yield* Schema.encodeEffect(AttemptOutcome)(AttemptAwaitingCi.make());
  const json9 = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
    valueDecoded9,
  ).pipe(Effect.orDie);
  const awaitingCiOutcome = json9;
  yield* sql`CREATE TEMP TABLE fixture_numbers AS WITH RECURSIVE n(i) AS (VALUES(0) UNION ALL SELECT i + 1 FROM n WHERE i < 999) SELECT i FROM n`;
  yield* sql`INSERT INTO usine_events (event_id, dedup_key, payload_json, received_at)
    SELECT 'event-' || i, 'dedup-' || i, '{}', ${at} FROM fixture_numbers`;
  yield* sql`INSERT INTO usine_trigger_events (event_id, item_key, loop_name, step_name, approval, repository, revision, task, agent_json)
    SELECT 'event-' || i, 'item-' || (i % 100), ${lifecycleSubmission.loop}, ${lifecycleSubmission.step}, 'none', ${lifecycleSubmission.repository}, ${lifecycleSubmission.revision}, ${lifecycleSubmission.task}, ${agent} FROM fixture_numbers`;
  yield* sql`INSERT INTO usine_runs (run_id, event_id, loop_name, state_json, opened_at, closed_at, repository, revision, task, agent_json)
    SELECT 'run-' || i, 'event-' || i, ${lifecycleSubmission.loop}, case when i = 888 then ${handedOff} when i = 989 then ${awaitingCi} when i >= 990 then ${running} else ${succeeded} end,
    strftime('%Y-%m-%dT%H:%M:%fZ', ${at}, '+' || i || ' seconds'),
    case when i < 989 then strftime('%Y-%m-%dT%H:%M:%fZ', ${at}, '+' || (i + 1) || ' seconds') end,
    ${lifecycleSubmission.repository}, ${lifecycleSubmission.revision}, ${lifecycleSubmission.task}, ${agent} FROM fixture_numbers`;
  yield* sql`INSERT INTO usine_steps (run_id, step_name) SELECT 'run-' || i, ${lifecycleSubmission.step} FROM fixture_numbers`;
  yield* sql`INSERT INTO usine_attempts (attempt_id, run_id, step_name, worker_name, attempt_number, brain_json, task, agent, started_at, outcome_json, ended_at)
    SELECT 'attempt-' || i, 'run-' || i, ${lifecycleSubmission.step}, 'local', 1, ${brain}, ${lifecycleSubmission.task}, ${testAgent.name}, ${at},
    case when i = 888 then ${handedOffOutcome} when i = 989 then ${awaitingCiOutcome} when i < 989 then ${succeededOutcome} end,
    case when i < 990 then strftime('%Y-%m-%dT%H:%M:%fZ', ${at}, '+' || (i + 1) || ' seconds') end FROM fixture_numbers`;
  const session = ParentSession.make({
    id: AgentSessionId.make("fixture-session"),
    agent: testAgent.name,
    brain: testAgent.brain,
  });
  const envelope = (payload: AttemptChannel.OutboundPayload) =>
    Schema.encodeEffect(AttemptChannel.OutboundEnvelope)(
      AttemptChannel.OutboundEnvelope.make({
        version: AttemptChannel.PROTOCOL_VERSION,
        attemptId: AttemptId.make("fixture-attempt"),
        sequence: AttemptChannel.Sequence.make(1),
        sentAt: DateTime.makeUnsafe(at),
        payload,
      }),
    ).pipe(Effect.map(JSON.stringify));
  const started = yield* envelope(
    AttemptChannel.SessionEvent.make({ event: SessionStarted.make({ session }) }),
  );
  const tokens = yield* envelope(
    AttemptChannel.SessionEvent.make({
      event: SessionTokensUpdated.make({ session, totalTokens: TokenCount.make(100) }),
    }),
  );
  const output = yield* envelope(
    AttemptChannel.SessionEvent.make({
      event: TextOutput.make({ session, text: "x".repeat(padding) }),
    }),
  );
  yield* sql`INSERT INTO usine_attempt_transcripts (attempt_id, direction, channel_sequence, envelope, received_at)
    SELECT 'attempt-' || n.i, 'outbound', t.i + 1,
      json_set(case when t.i < 2 then ${started} when t.i % 20 = 19 then ${tokens} else ${output} end,
        '$.attemptId', 'attempt-' || n.i, '$.sequence', t.i + 1,
        '$.payload.event.session.id', 'session-' || n.i || '-' || (case when t.i < 2 then t.i else (t.i / 20) % 2 end)),
      ${at}
    FROM fixture_numbers n CROSS JOIN fixture_numbers t WHERE t.i < 200`;
  yield* sql`INSERT INTO usine_session_usage (attempt_id, session_id, total_tokens, sequence, received_at, envelope)
    SELECT attempt_id, session_id, max(json_extract(envelope, '$.payload.event.totalTokens')), sequence, received_at, envelope
    FROM usine_attempt_transcripts WHERE payload_tag = 'SessionEvent' AND event_tag = 'SessionTokensUpdated'
    GROUP BY attempt_id, session_id`;
  const pool = yield* envelope(
    AttemptChannel.SessionEvent.make({
      event: PoolRateLimitsUpdated.make({
        session,
        pool: "chatgptPlan",
        login: Option.none(),
        rateLimits: RateLimitsSnapshot.make({
          limitId: Option.none(),
          limitName: Option.none(),
          primary: Option.none(),
          secondary: Option.none(),
        }),
      }),
    }),
  );
  yield* sql`INSERT INTO usine_attempt_transcripts (attempt_id, direction, channel_sequence, envelope, received_at)
    VALUES ('attempt-0', 'outbound', 201, json_set(${pool}, '$.attemptId', 'attempt-0', '$.sequence', 201), ${at})`;
  yield* sql`INSERT INTO usine_pool_rate_limits (pool, sequence, attempt_id, received_at, envelope)
    SELECT 'chatgptPlan', sequence, attempt_id, received_at, envelope FROM usine_attempt_transcripts WHERE attempt_id = 'attempt-0' AND channel_sequence = 201`;
  yield* sql`DROP TABLE fixture_numbers`;
  yield* sql`PRAGMA wal_checkpoint(TRUNCATE)`;
});

import { Attempt, AttemptFailure, Event, Item, Loop, Run, RunState } from "@usine/core";
import { Cause, DateTime, Context, Effect, Exit, Layer, Option, Schema } from "effect";
import { Migrator, SqlClient } from "effect/unstable/sql";
import type { Workflow } from "effect/unstable/workflow";
import {
  Claimed,
  Ignored,
  Queued,
  RunNotFoundError,
  RunOperationRejectedError,
  RunSnapshot,
  StepExecution,
  Submission,
} from "./model.ts";
import {
  EventRouteRow,
  attemptFromRow,
  decodeAttemptRows,
  decodeCounts,
  decodeDiscards,
  decodeEventRoutes,
  decodeRunIds,
  decodeRunRows,
  decodeWorkflowCommands,
  encodeDateTime,
  encodeOutcome,
  encodePayload,
  encodeRunState,
  eventFromRow,
  migrations,
  persistence,
  runFromRow,
  stepFromRow,
  submissionFromRow,
  type WorkflowCommand,
} from "./run-store-schema.ts";

const MAX_AUTO_ATTEMPTS = Attempt.AttemptNumber.make(3);

class StoredSubmission extends Schema.Class<StoredSubmission>(
  "@usine/engine/internal/StoredSubmission",
)({
  submission: Submission,
  runId: Run.RunId,
}) {}

class RecoverableRun extends Schema.Class<RecoverableRun>("@usine/engine/internal/RecoverableRun")({
  submission: Submission,
  runId: Run.RunId,
  state: RunState.RunState,
}) {}

class Claim extends Schema.Class<Claim>("@usine/engine/internal/Claim")({
  submission: Submission,
  result: Schema.Union([Claimed, Queued, Ignored]),
  supersededRun: Schema.Option(Run.RunId),
}) {}

class AttemptStarted extends Schema.TaggedClass<AttemptStarted>(
  "@usine/engine/internal/AttemptStarted",
)("AttemptStarted", {
  execution: StepExecution,
}) {}

class AttemptRecoveryFailed extends Schema.TaggedClass<AttemptRecoveryFailed>(
  "@usine/engine/internal/AttemptRecoveryFailed",
)("AttemptRecoveryFailed", {
  failure: AttemptFailure.InfraFailure,
}) {}

const makeRunStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`PRAGMA foreign_keys = ON`.pipe(persistence("enable foreign keys"));
  yield* Migrator.make({})({
    loader: migrations,
    table: "usine_migrations",
  }).pipe(persistence("migrate usine runtime tables"));

  const eventRouteByDedup = Effect.fn("RunStore.eventRouteByDedup")(function* (
    dedupKey: Event.DedupKey,
  ) {
    const rows = yield* sql`
      SELECT
        e.event_id AS "eventId",
        e.dedup_key AS "dedupKey",
        e.payload_json AS payload,
        e.received_at AS "receivedAt",
        t.item_key AS "itemKey",
        t.loop_name AS loop,
        t.step_name AS step,
        t.approval AS approval
      FROM usine_events e
      JOIN usine_trigger_events t ON t.event_id = e.event_id
      WHERE e.dedup_key = ${dedupKey}
    `;
    return yield* decodeEventRoutes(rows);
  });

  const runRow = Effect.fn("RunStore.runRow")(function* (runId: Run.RunId) {
    const rows = yield* sql`
      SELECT
        r.run_id AS "runId",
        r.event_id AS "eventId",
        r.loop_name AS loop,
        r.state_json AS state,
        r.opened_at AS "openedAt",
        s.step_name AS "stepName",
        s.result AS result
      FROM usine_runs r
      JOIN usine_steps s ON s.run_id = r.run_id
      WHERE r.run_id = ${runId}
    `;
    return yield* decodeRunRows(rows);
  });

  const attemptRows = Effect.fn("RunStore.attemptRows")(function* (runId: Run.RunId) {
    const rows = yield* sql`
      SELECT
        attempt_id AS "attemptId",
        run_id AS "runId",
        step_name AS "stepName",
        CAST(attempt_number AS INTEGER) AS number,
        started_at AS "startedAt",
        outcome_json AS outcome
      FROM usine_attempts
      WHERE run_id = ${runId}
      ORDER BY attempt_number
    `;
    return yield* decodeAttemptRows(rows);
  });

  const snapshot = Effect.fn("RunStore.snapshot")(function* (runId: Run.RunId) {
    const [runs, attempts, routes] = yield* Effect.all([
      runRow(runId),
      attemptRows(runId),
      sql`
        SELECT
          e.event_id AS "eventId",
          e.dedup_key AS "dedupKey",
          e.payload_json AS payload,
          e.received_at AS "receivedAt",
          t.item_key AS "itemKey",
          t.loop_name AS loop,
          t.step_name AS step,
          t.approval AS approval
        FROM usine_runs r
        JOIN usine_events e ON e.event_id = r.event_id
        JOIN usine_trigger_events t ON t.event_id = e.event_id
        WHERE r.run_id = ${runId}
      `.pipe(Effect.flatMap(decodeEventRoutes)),
    ]);
    const run = runs[0];
    const route = routes[0];
    if (run === undefined || route === undefined) {
      return yield* new RunNotFoundError({ runId });
    }
    return new RunSnapshot({
      event: eventFromRow(route),
      run: runFromRow(run),
      step: stepFromRow(run),
      attempts: attempts.map(attemptFromRow),
    });
  });

  const updateState = Effect.fn("RunStore.updateState")(function* (
    runId: Run.RunId,
    state: RunState.RunState,
  ) {
    yield* sql`
      UPDATE usine_runs
      SET state_json = ${encodeRunState(state)}
      WHERE run_id = ${runId}
    `;
  });

  const requestWorkflowCommand = Effect.fn("RunStore.requestWorkflowCommand")(function* (
    runId: Run.RunId,
    command: WorkflowCommand,
  ) {
    yield* sql`
      INSERT OR IGNORE INTO usine_workflow_commands(run_id, command)
      VALUES (${runId}, ${command})
    `;
  });

  const requestInterrupt = Effect.fn("RunStore.requestInterrupt")(function* (runId: Run.RunId) {
    yield* sql`
      DELETE FROM usine_workflow_commands
      WHERE run_id = ${runId} AND command IN ('Approve', 'Resume')
    `;
    yield* requestWorkflowCommand(runId, "Interrupt");
  });

  const hasWorkflowCommand = Effect.fn("RunStore.hasWorkflowCommand")(function* (
    runId: Run.RunId,
    command: WorkflowCommand,
  ) {
    const rows = yield* sql`
      SELECT COUNT(*) AS count
      FROM usine_workflow_commands
      WHERE run_id = ${runId} AND command = ${command}
    `.pipe(Effect.flatMap(decodeCounts));
    return (rows[0]?.count ?? 0) > 0;
  });

  const createRun = Effect.fn("RunStore.createRun")(function* (
    submission: Submission,
    eventId: Event.EventId,
    runId: Run.RunId,
  ) {
    yield* sql`
      INSERT OR IGNORE INTO usine_ignored_events(event_id, reason)
      SELECT candidate.event_id, 'superseded'
      FROM usine_trigger_events candidate
      LEFT JOIN usine_runs candidate_run ON candidate_run.event_id = candidate.event_id
      LEFT JOIN usine_ignored_events ignored ON ignored.event_id = candidate.event_id
      WHERE candidate.loop_name = ${submission.loop}
        AND candidate.item_key = ${submission.itemKey}
        AND candidate.event_id != ${eventId}
        AND candidate_run.run_id IS NULL
        AND ignored.event_id IS NULL
    `;
    yield* sql`
      INSERT OR IGNORE INTO usine_runs(run_id, event_id, loop_name, state_json, opened_at)
      VALUES (
        ${runId},
        ${eventId},
        ${submission.loop},
        ${encodeRunState(new RunState.Pending())},
        ${encodeDateTime(submission.event.receivedAt)}
      )
    `;
    yield* sql`
      INSERT OR IGNORE INTO usine_steps(run_id, step_name, result)
      VALUES (${runId}, ${submission.step}, NULL)
    `;
  });

  const openRun = Effect.fn("RunStore.openRun")(function* (
    submission: Submission,
    runId: Run.RunId,
    supersededRun: Option.Option<Run.RunId>,
  ) {
    yield* createRun(submission, submission.event.id, runId);
    return new Claim({
      submission,
      result: new Claimed({ eventId: submission.event.id, runId }),
      supersededRun,
    });
  });

  const runForEvent = Effect.fn("RunStore.runForEvent")(function* (eventId: Event.EventId) {
    const rows = yield* sql`
      SELECT run_id AS "runId"
      FROM usine_runs
      WHERE event_id = ${eventId}
    `;
    return yield* decodeRunIds(rows);
  });

  const ignoredEvent = Effect.fn("RunStore.ignoredEvent")(function* (eventId: Event.EventId) {
    const rows = yield* sql`
      SELECT reason
      FROM usine_ignored_events
      WHERE event_id = ${eventId}
    `;
    return yield* decodeDiscards(rows);
  });

  const blockingRun = Effect.fn("RunStore.blockingRun")(function* (
    loop: Loop.LoopName,
    itemKey: Item.ItemKey,
  ) {
    const rows = yield* sql`
      SELECT r.run_id AS "runId"
      FROM usine_runs r
      JOIN usine_trigger_events t ON t.event_id = r.event_id
      WHERE t.loop_name = ${loop}
        AND t.item_key = ${itemKey}
        AND json_extract(r.state_json, '$._tag') IN ('Pending', 'Waiting', 'Running')
      ORDER BY r.opened_at DESC
      LIMIT 1
    `;
    return yield* decodeRunIds(rows);
  });

  const recordTriggerEvent = Effect.fn("RunStore.recordTriggerEvent")(function* (
    submission: Submission,
  ) {
    yield* sql`
      INSERT OR IGNORE INTO usine_events(event_id, dedup_key, payload_json, received_at)
      VALUES (
        ${submission.event.id},
        ${submission.event.dedupKey},
        ${encodePayload(submission.event.payload)},
        ${encodeDateTime(submission.event.receivedAt)}
      )
    `;
    const routes = yield* eventRouteByDedup(submission.event.dedupKey);
    if (routes.length === 0) {
      yield* sql`
        INSERT INTO usine_trigger_events(event_id, item_key, loop_name, step_name, approval)
        VALUES (
          ${submission.event.id},
          ${submission.itemKey},
          ${submission.loop},
          ${submission.step},
          ${submission.approval}
        )
      `;
      return submission;
    }
    return submissionFromRow(routes[0]);
  });

  const recordAndClaim = Effect.fn("RunStore.recordAndClaim")(function* (
    submission: Submission,
    requestedRunId: Run.RunId,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const recorded = yield* recordTriggerEvent(submission);
        const existing = yield* runForEvent(recorded.event.id);
        if (existing[0] !== undefined) {
          return new Claim({
            submission: recorded,
            result: new Claimed({ eventId: recorded.event.id, runId: existing[0].runId }),
            supersededRun: Option.none(),
          });
        }

        const ignored = yield* ignoredEvent(recorded.event.id);
        if (ignored[0] !== undefined) {
          return new Claim({
            submission: recorded,
            result: new Ignored({
              eventId: recorded.event.id,
              reason: ignored[0].reason,
            }),
            supersededRun: Option.none(),
          });
        }

        const blocking = yield* blockingRun(recorded.loop, recorded.itemKey);
        const blockedBy = blocking[0];
        if (blockedBy === undefined) {
          return yield* openRun(recorded, requestedRunId, Option.none());
        }

        const blockedSnapshot = yield* snapshot(blockedBy.runId);
        if (blockedSnapshot.run.state._tag === "Running") {
          return new Claim({
            submission: recorded,
            result: new Queued({ eventId: recorded.event.id }),
            supersededRun: Option.none(),
          });
        }
        if (
          blockedSnapshot.run.state._tag === "Pending" ||
          blockedSnapshot.run.state._tag === "Waiting"
        ) {
          yield* updateState(
            blockedSnapshot.run.id,
            RunState.supersede(blockedSnapshot.run.state, recorded.event.id),
          );
          yield* requestInterrupt(blockedSnapshot.run.id);
          return yield* openRun(recorded, requestedRunId, Option.some(blockedSnapshot.run.id));
        }
        return yield* openRun(recorded, requestedRunId, Option.none());
      }),
    );
  });

  const parkForApproval = Effect.fn("RunStore.parkForApproval")(function* (runId: Run.RunId) {
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const current = yield* snapshot(runId);
        if (current.run.state._tag === "Pending") {
          yield* updateState(runId, RunState.awaitApproval(current.run.state));
        }
      }),
    );
  });

  const beginAttempt = Effect.fn("RunStore.beginAttempt")(function* (runId: Run.RunId) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const current = yield* snapshot(runId);
        let runState = current.run.state;
        const lastAttempt = current.attempts[current.attempts.length - 1];
        if (
          runState._tag === "Running" &&
          lastAttempt !== undefined &&
          Option.isNone(lastAttempt.outcome)
        ) {
          const failure = new AttemptFailure.InfraFailure({
            message: "The orchestrator stopped during the attempt",
            cause: new Error("attempt interrupted by orchestrator restart"),
          });
          yield* sql`
            UPDATE usine_attempts
            SET outcome_json = ${encodeOutcome(new Attempt.Failed({ failure }))}
            WHERE attempt_id = ${lastAttempt.id}
          `;
          if (
            !Attempt.shouldAutoRetry({
              failure,
              number: lastAttempt.number,
              maxAutoAttempts: MAX_AUTO_ATTEMPTS,
            })
          ) {
            yield* updateState(runId, RunState.fail(runState));
            yield* requestWorkflowCommand(runId, "Continue");
            return new AttemptRecoveryFailed({ failure });
          }
        }

        if (runState._tag === "Pending" || runState._tag === "Waiting") {
          runState = RunState.start(runState);
          yield* updateState(runId, runState);
        }
        if (runState._tag !== "Running") {
          return yield* new RunOperationRejectedError({
            runId,
            operation: "retry",
            state: runState._tag,
          });
        }

        const number = Attempt.AttemptNumber.make((lastAttempt?.number ?? 0) + 1);
        const attemptId = Attempt.AttemptId.make(`${runId}/${current.step.name}/${number}`);
        const startedAt = yield* DateTime.now;
        yield* sql`
          INSERT INTO usine_attempts(
            attempt_id,
            run_id,
            step_name,
            attempt_number,
            started_at,
            outcome_json
          ) VALUES (
            ${attemptId},
            ${runId},
            ${current.step.name},
            ${number},
            ${encodeDateTime(startedAt)},
            NULL
          )
        `;
        const attempt = new Attempt.Attempt({
          id: attemptId,
          runId,
          stepName: current.step.name,
          number,
          startedAt,
          outcome: Option.none(),
        });
        return new AttemptStarted({
          execution: new StepExecution({
            attempt,
            event: current.event,
            run: new Run.Run({
              id: current.run.id,
              eventId: current.run.eventId,
              loop: current.run.loop,
              state: runState,
              openedAt: current.run.openedAt,
            }),
            step: current.step,
          }),
        });
      }),
    );
  });

  const succeedAttempt = Effect.fn("RunStore.succeedAttempt")(function* (
    attempt: Attempt.Attempt,
    result: string,
  ) {
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const current = yield* snapshot(attempt.runId);
        if (current.run.state._tag !== "Running") return;
        yield* sql`
          UPDATE usine_attempts
          SET outcome_json = ${encodeOutcome(new Attempt.Succeeded())}
          WHERE attempt_id = ${attempt.id} AND outcome_json IS NULL
        `;
        yield* sql`
          UPDATE usine_steps
          SET result = ${result}
          WHERE run_id = ${attempt.runId} AND step_name = ${attempt.stepName}
        `;
        yield* updateState(attempt.runId, RunState.succeed(current.run.state));
        yield* requestWorkflowCommand(attempt.runId, "Continue");
      }),
    );
  });

  const failAttempt = Effect.fn("RunStore.failAttempt")(function* (
    attempt: Attempt.Attempt,
    failure: AttemptFailure.AttemptFailure,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const current = yield* snapshot(attempt.runId);
        if (current.run.state._tag !== "Running") return false;
        yield* sql`
          UPDATE usine_attempts
          SET outcome_json = ${encodeOutcome(new Attempt.Failed({ failure }))}
          WHERE attempt_id = ${attempt.id} AND outcome_json IS NULL
        `;
        const retry = Attempt.shouldAutoRetry({
          failure,
          number: attempt.number,
          maxAutoAttempts: MAX_AUTO_ATTEMPTS,
        });
        if (!retry) {
          yield* updateState(attempt.runId, RunState.fail(current.run.state));
          yield* requestWorkflowCommand(attempt.runId, "Continue");
        }
        return retry;
      }),
    );
  });

  const approve = Effect.fn("RunStore.approve")(function* (
    runId: Run.RunId,
    approval: Event.Event,
  ) {
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const existing = yield* sql`
          SELECT COUNT(*) AS count
          FROM usine_approvals
          WHERE run_id = ${runId}
        `.pipe(Effect.flatMap(decodeCounts));
        if ((existing[0]?.count ?? 0) > 0) return;

        const current = yield* snapshot(runId);
        if (current.run.state._tag !== "Waiting") {
          return yield* new RunOperationRejectedError({
            runId,
            operation: "approve",
            state: current.run.state._tag,
          });
        }
        yield* sql`
          INSERT OR IGNORE INTO usine_events(event_id, dedup_key, payload_json, received_at)
          VALUES (
            ${approval.id},
            ${approval.dedupKey},
            ${encodePayload(approval.payload)},
            ${encodeDateTime(approval.receivedAt)}
          )
        `;
        yield* sql`
          INSERT INTO usine_approvals(run_id, event_id)
          VALUES (${runId}, ${approval.id})
        `;
        yield* requestWorkflowCommand(runId, "Approve");
      }),
    );
  });

  const retry = Effect.fn("RunStore.retry")(function* (runId: Run.RunId) {
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const current = yield* snapshot(runId);
        if (current.run.state._tag === "Failed") {
          yield* updateState(runId, RunState.retry(current.run.state));
          yield* requestWorkflowCommand(runId, "Resume");
          return;
        }
        if (current.run.state._tag === "Running" && (yield* hasWorkflowCommand(runId, "Resume"))) {
          return;
        }
        return yield* new RunOperationRejectedError({
          runId,
          operation: "retry",
          state: current.run.state._tag,
        });
      }),
    );
  });

  const cancel = Effect.fn("RunStore.cancel")(function* (runId: Run.RunId) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const current = yield* snapshot(runId);
        if (RunState.isOpen(current.run.state)) {
          if (current.run.state._tag === "Running") {
            const attempt = current.attempts[current.attempts.length - 1];
            if (attempt !== undefined && Option.isNone(attempt.outcome)) {
              yield* sql`
                UPDATE usine_attempts
                SET outcome_json = ${encodeOutcome(new Attempt.Canceled())}
                WHERE attempt_id = ${attempt.id} AND outcome_json IS NULL
              `;
            }
          }
          yield* updateState(runId, RunState.cancelByOperator(current.run.state));
          yield* requestInterrupt(runId);
          yield* requestWorkflowCommand(runId, "Continue");
          return true;
        }
        return false;
      }),
    );
  });

  const revoke = Effect.fn("RunStore.revoke")(function* (
    loop: Loop.LoopName,
    itemKey: Item.ItemKey,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const rows = yield* sql`
          SELECT r.run_id AS "runId"
          FROM usine_runs r
          JOIN usine_trigger_events t ON t.event_id = r.event_id
          WHERE t.loop_name = ${loop}
            AND t.item_key = ${itemKey}
            AND json_extract(r.state_json, '$._tag') IN ('Pending', 'Waiting')
        `.pipe(Effect.flatMap(decodeRunIds));
        for (const row of rows) {
          const current = yield* snapshot(row.runId);
          if (current.run.state._tag === "Pending" || current.run.state._tag === "Waiting") {
            yield* updateState(row.runId, RunState.revoke(current.run.state));
            yield* requestInterrupt(row.runId);
          }
        }
        yield* sql`
          INSERT OR IGNORE INTO usine_ignored_events(event_id, reason)
          SELECT candidate.event_id, 'revoked'
          FROM usine_trigger_events candidate
          LEFT JOIN usine_runs candidate_run ON candidate_run.event_id = candidate.event_id
          WHERE candidate.loop_name = ${loop}
            AND candidate.item_key = ${itemKey}
            AND candidate_run.run_id IS NULL
        `;
        return rows.map((row) => row.runId);
      }),
    );
  });

  const nextQueued = Effect.fn("RunStore.nextQueued")(function* (runId: Run.RunId) {
    const currentRoutes = yield* sql`
      SELECT
        e.event_id AS "eventId",
        e.dedup_key AS "dedupKey",
        e.payload_json AS payload,
        e.received_at AS "receivedAt",
        t.item_key AS "itemKey",
        t.loop_name AS loop,
        t.step_name AS step,
        t.approval AS approval
      FROM usine_runs r
      JOIN usine_events e ON e.event_id = r.event_id
      JOIN usine_trigger_events t ON t.event_id = e.event_id
      WHERE r.run_id = ${runId}
    `.pipe(Effect.flatMap(decodeEventRoutes));
    const current = currentRoutes[0];
    if (current === undefined) return Option.none<Submission>();
    const queued = yield* sql`
      SELECT
        e.event_id AS "eventId",
        e.dedup_key AS "dedupKey",
        e.payload_json AS payload,
        e.received_at AS "receivedAt",
        t.item_key AS "itemKey",
        t.loop_name AS loop,
        t.step_name AS step,
        t.approval AS approval
      FROM usine_events e
      JOIN usine_trigger_events t ON t.event_id = e.event_id
      LEFT JOIN usine_runs r ON r.event_id = e.event_id
      LEFT JOIN usine_ignored_events ignored ON ignored.event_id = e.event_id
      WHERE t.loop_name = ${current.loop}
        AND t.item_key = ${current.itemKey}
        AND r.run_id IS NULL
        AND ignored.event_id IS NULL
      ORDER BY e.received_at DESC
      LIMIT 1
    `.pipe(Effect.flatMap(decodeEventRoutes));
    return Option.fromNullishOr(queued[0]).pipe(Option.map(submissionFromRow));
  });

  const claimQueued = Effect.fn("RunStore.claimQueued")(function* (
    submission: Submission,
    runId: Run.RunId,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const existing = yield* runForEvent(submission.event.id);
        if (existing[0] !== undefined) {
          return Option.some(new StoredSubmission({ submission, runId: existing[0].runId }));
        }
        if ((yield* ignoredEvent(submission.event.id)).length > 0) {
          return Option.none<StoredSubmission>();
        }
        const blocking = yield* blockingRun(submission.loop, submission.itemKey);
        if (blocking.length > 0) return Option.none<StoredSubmission>();
        yield* createRun(submission, submission.event.id, runId);
        return Option.some(new StoredSubmission({ submission, runId }));
      }),
    );
  });

  const recoverable = Effect.fn("RunStore.recoverable")(function* () {
    const rows = yield* sql`
      SELECT
        e.event_id AS "eventId",
        e.dedup_key AS "dedupKey",
        e.payload_json AS payload,
        e.received_at AS "receivedAt",
        t.item_key AS "itemKey",
        t.loop_name AS loop,
        t.step_name AS step,
        t.approval AS approval,
        r.run_id AS "runId",
        r.state_json AS state
      FROM usine_runs r
      JOIN usine_events e ON e.event_id = r.event_id
      JOIN usine_trigger_events t ON t.event_id = e.event_id
      WHERE json_extract(r.state_json, '$._tag') IN ('Pending', 'Waiting', 'Running')
    `;
    const StoredRow = Schema.Struct({
      ...EventRouteRow.fields,
      runId: Run.RunId,
      state: Schema.fromJsonString(RunState.RunState),
    });
    const decoded = yield* Schema.decodeUnknownEffect(Schema.Array(StoredRow))(rows);
    return decoded.map(
      (row) =>
        new RecoverableRun({
          submission: submissionFromRow(row),
          runId: row.runId,
          state: row.state,
        }),
    );
  });

  const pendingWorkflowCommands = Effect.fn("RunStore.pendingWorkflowCommands")(function* () {
    const rows = yield* sql`
      SELECT run_id AS "runId", command
      FROM usine_workflow_commands
      ORDER BY run_id, command DESC
    `;
    return yield* decodeWorkflowCommands(rows);
  });

  const completeWorkflowCommand = Effect.fn("RunStore.completeWorkflowCommand")(function* (
    runId: Run.RunId,
    command: WorkflowCommand,
  ) {
    yield* sql`
      DELETE FROM usine_workflow_commands
      WHERE run_id = ${runId} AND command = ${command}
    `;
  });

  const reconcileCompletion = Effect.fn("RunStore.reconcileCompletion")(function* (
    runId: Run.RunId,
    result: Workflow.Result<string, AttemptFailure.AttemptFailure>,
  ) {
    if (result._tag !== "Complete") return;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const current = yield* snapshot(runId);
        if (current.run.state._tag !== "Running") return;
        const attempt = current.attempts[current.attempts.length - 1];
        if (attempt === undefined || Option.isSome(attempt.outcome)) return;
        if (Exit.isSuccess(result.exit)) {
          yield* sql`
            UPDATE usine_attempts
            SET outcome_json = ${encodeOutcome(new Attempt.Succeeded())}
            WHERE attempt_id = ${attempt.id} AND outcome_json IS NULL
          `;
          yield* sql`
            UPDATE usine_steps
            SET result = ${result.exit.value}
            WHERE run_id = ${attempt.runId} AND step_name = ${attempt.stepName}
          `;
          yield* updateState(runId, RunState.succeed(current.run.state));
          yield* requestWorkflowCommand(runId, "Continue");
          return;
        }
        const failure = Cause.findErrorOption(result.exit.cause);
        if (Option.isNone(failure)) return;
        yield* sql`
          UPDATE usine_attempts
          SET outcome_json = ${encodeOutcome(new Attempt.Failed({ failure: failure.value }))}
          WHERE attempt_id = ${attempt.id} AND outcome_json IS NULL
        `;
        yield* updateState(runId, RunState.fail(current.run.state));
        yield* requestWorkflowCommand(runId, "Continue");
      }),
    );
  });

  return {
    approve: (runId: Run.RunId, approval: Event.Event) =>
      approve(runId, approval).pipe(persistence("approve run")),
    beginAttempt: (runId: Run.RunId) => beginAttempt(runId).pipe(persistence("begin attempt")),
    cancel: (runId: Run.RunId) => cancel(runId).pipe(persistence("cancel run")),
    claimQueued: (submission: Submission, runId: Run.RunId) =>
      claimQueued(submission, runId).pipe(persistence("claim queued Event")),
    failAttempt: (attempt: Attempt.Attempt, failure: AttemptFailure.AttemptFailure) =>
      failAttempt(attempt, failure).pipe(persistence("fail attempt")),
    completeWorkflowCommand: (runId: Run.RunId, command: WorkflowCommand) =>
      completeWorkflowCommand(runId, command).pipe(persistence("complete workflow command")),
    nextQueued: (runId: Run.RunId) => nextQueued(runId).pipe(persistence("find queued Event")),
    pendingWorkflowCommands: pendingWorkflowCommands().pipe(
      persistence("list pending workflow commands"),
    ),
    parkForApproval: (runId: Run.RunId) =>
      parkForApproval(runId).pipe(persistence("park run for approval")),
    recordAndClaim: (submission: Submission, runId: Run.RunId) =>
      recordAndClaim(submission, runId).pipe(persistence("submit Event")),
    recoverable: recoverable().pipe(persistence("list recoverable runs")),
    reconcileCompletion: (
      runId: Run.RunId,
      result: Workflow.Result<string, AttemptFailure.AttemptFailure>,
    ) => reconcileCompletion(runId, result).pipe(persistence("reconcile workflow completion")),
    retry: (runId: Run.RunId) => retry(runId).pipe(persistence("retry run")),
    revoke: (loop: Loop.LoopName, itemKey: Item.ItemKey) =>
      revoke(loop, itemKey).pipe(persistence("revoke run")),
    snapshot: (runId: Run.RunId) => snapshot(runId).pipe(persistence("read run")),
    succeedAttempt: (attempt: Attempt.Attempt, result: string) =>
      succeedAttempt(attempt, result).pipe(persistence("succeed attempt")),
  } as const;
});

export class RunStore extends Context.Service<RunStore, Effect.Success<typeof makeRunStore>>()(
  "@usine/engine/internal/RunStore",
) {
  static readonly layer = Layer.effect(RunStore, makeRunStore);
}

export { AttemptRecoveryFailed };

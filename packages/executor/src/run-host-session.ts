import { Attempt, AttemptChannel, AttemptFailure, StepResult } from "@usine/core";
import {
  Cause,
  DateTime,
  Effect,
  Fiber,
  Option,
  Queue,
  Ref,
  Result,
  Schema,
  SchemaIssue,
  Scope,
  Stream,
  type PlatformError,
} from "effect";
import type { ChildProcessHandle } from "effect/unstable/process/ChildProcessSpawner";
import { ExecutorError, ExecutorOperationError, type PreparedAttempt } from "./index.ts";

export interface SpawnedRunHost {
  readonly handle: ChildProcessHandle;
  readonly host: string;
  /** Redacts the Attempt credential from any run-host output before it is persisted. */
  readonly scrub: (text: string) => string;
}

export type RunHostInput = Queue.Queue<Uint8Array, Cause.Done>;

export interface RunHostSessionOptions {
  readonly interruptGrace: Parameters<typeof Effect.timeoutOption>[1];
  readonly spawn: (
    prepared: PreparedAttempt,
    input: RunHostInput,
  ) => Effect.Effect<
    SpawnedRunHost,
    AttemptFailure.AttemptFailure | PlatformError.PlatformError,
    Scope.Scope
  >;
}

export interface RunHostSession {
  readonly cancel: (attemptId: Attempt.AttemptId) => Effect.Effect<void, ExecutorError>;
  readonly launch: (
    prepared: PreparedAttempt,
    io: AttemptChannel.Sink,
  ) => Effect.Effect<StepResult.StepResult, AttemptFailure.AttemptFailure>;
}

interface ActiveAttempt {
  readonly cancelStarted: Ref.Ref<boolean>;
  readonly handle: ChildProcessHandle;
  readonly host: string;
  readonly input: Queue.Queue<Uint8Array, Cause.Done>;
  readonly io: AttemptChannel.Sink;
  readonly sequence: Ref.Ref<number>;
  readonly worker: PreparedAttempt["worker"];
}

const STDERR_TAIL_BYTES = 4_096;
/** Sending SIGKILL is its own bounded step, unrelated to the interrupt grace. */
const KILL_TIMEOUT = "5 seconds";
const inputFrameToJson = Schema.encodeSync(AttemptChannel.InputFrameFromJson);
/** Strict by contract: an unknown key on a protocol frame is a rejected frame. */
const decodeOutboundEnvelope = (line: string) =>
  Schema.decodeUnknownEffect(AttemptChannel.OutboundEnvelopeFromJson)(line, {
    onExcessProperty: "error",
  });
const isExecutorError = Schema.is(ExecutorError);
const encoder = new TextEncoder();

const SAFE_TAG_VALUES = [
  "Started",
  "SessionEvent",
  "Final",
  "Failed",
  "Interrupted",
  "SessionStarted",
  "TextOutput",
  "ToolStarted",
  "ToolFinished",
  "PoolRateLimitsUpdated",
  "SessionFinished",
] as const;
const SafeFrameTag = Schema.Literals(SAFE_TAG_VALUES);
const FramePreview = Schema.Struct({
  version: Schema.optionalKey(Schema.Int),
  payload: Schema.optionalKey(
    Schema.Struct({
      _tag: Schema.optionalKey(Schema.String),
      event: Schema.optionalKey(Schema.Struct({ _tag: Schema.optionalKey(Schema.String) })),
    }),
  ),
});
const decodeJsonOption = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json));
const decodeFramePreviewOption = Schema.decodeUnknownOption(FramePreview);
const decodeSafeFrameTagOption = Schema.decodeUnknownOption(SafeFrameTag);
const SAFE_PATH_SEGMENTS = new Set([
  "version",
  "attemptId",
  "sequence",
  "sentAt",
  "payload",
  "_tag",
  "event",
  "session",
  "id",
  "parentId",
  "agent",
  "brain",
  "harness",
  "model",
  "effort",
  "callId",
  "tool",
  "input",
  "output",
  "isError",
  "text",
  "pool",
  "rateLimits",
  "parentModel",
  "result",
  "failure",
]);

type FrameSource = "effect-log" | "json" | "non-json";

export interface InvalidFrameDiagnostic {
  readonly byteLength: number;
  readonly eventTag: string | undefined;
  readonly issues: ReadonlyArray<{ readonly message: string; readonly path: string }>;
  readonly payloadTag: string | undefined;
  readonly source: FrameSource;
  readonly version: number | undefined;
}

const formatSchemaIssues = SchemaIssue.makeFormatterStandardSchemaV1();
type FormattedIssuePath = NonNullable<
  ReturnType<typeof formatSchemaIssues>["issues"][number]["path"]
>;

const safeIssuePath = (path: FormattedIssuePath): string =>
  path
    .map((segment) => {
      const value = String(segment);
      return SAFE_PATH_SEGMENTS.has(value) ? value : "<unexpected>";
    })
    .join(".");

/** Redacted frame diagnostics: shape and schema metadata only, never frame content. */
export const invalidFrameDiagnostic = (line: string, cause: unknown): InvalidFrameDiagnostic => {
  const byteLength = encoder.encode(line).byteLength;
  const parsed = decodeJsonOption(line);
  if (Option.isNone(parsed)) {
    return {
      byteLength,
      eventTag: undefined,
      issues: [],
      payloadTag: undefined,
      source: /^\[\d{2}:\d{2}:\d{2}[.\]]/u.test(line) ? "effect-log" : "non-json",
      version: undefined,
    };
  }
  const preview = decodeFramePreviewOption(parsed.value);
  const issues = Schema.isSchemaError(cause)
    ? formatSchemaIssues(cause.issue).issues.map((issue) => ({
        message: issue.message.slice(0, 200),
        path: safeIssuePath(issue.path ?? []),
      }))
    : [];
  return {
    byteLength,
    eventTag: Option.flatMap(preview, ({ payload }) =>
      decodeSafeFrameTagOption(payload?.event?._tag),
    ).pipe(Option.getOrUndefined),
    issues,
    payloadTag: Option.flatMap(preview, ({ payload }) =>
      decodeSafeFrameTagOption(payload?._tag),
    ).pipe(Option.getOrUndefined),
    source: "json",
    version: Option.map(preview, ({ version }) => version).pipe(Option.getOrUndefined),
  };
};

const invalidFrameMessage = (diagnostic: InvalidFrameDiagnostic): string => {
  if (diagnostic.source !== "json") {
    return diagnostic.source === "effect-log"
      ? "The run host wrote a log line to its protocol output"
      : "The run host emitted malformed JSON";
  }
  const first = diagnostic.issues[0];
  return first === undefined
    ? "The run host emitted a schema-invalid frame"
    : `The run host emitted a schema-invalid frame at ${first.path || "<root>"}: ${first.message}`;
};

const frame = (input: AttemptChannel.InputFrame): Uint8Array =>
  encoder.encode(`${inputFrameToJson(input)}\n`);

const infrastructureFailure = (message: string, cause: unknown) =>
  new AttemptFailure.InfraFailure({ message, cause });

const violationFailure = (violation: AttemptChannel.Violation) =>
  infrastructureFailure(violation.message, new Error(violation.detail));

const cancelError = (attemptId: Attempt.AttemptId, cause: unknown) =>
  new ExecutorOperationError({
    operation: "cancel",
    message: `Could not cancel Attempt ${attemptId}`,
    cause,
  });

/** One canonical byte-channel state machine shared by every process-backed Executor. */
export const runHostSessionFor: (options: RunHostSessionOptions) => Effect.Effect<RunHostSession> =
  Effect.fn("RunHostSession.for")(function* (options: RunHostSessionOptions) {
    const activeAttempts = yield* Ref.make(new Map<Attempt.AttemptId, ActiveAttempt>());

    const hardKill = Effect.fn("RunHostSession.hardKill")(function* (
      attemptId: Attempt.AttemptId,
      active: ActiveAttempt,
      reason: "delivery-failed" | "grace-expired",
    ) {
      yield* Effect.logWarning("Hard-killing the run host", {
        attemptId,
        worker: active.worker,
        host: active.host,
        reason,
      });
      // Best-effort by design: the kill failure is logged, never propagated,
      // so it cannot mask the failure that forced the hard kill.
      yield* active.handle.kill({ killSignal: "SIGKILL" }).pipe(
        Effect.timeout(KILL_TIMEOUT),
        Effect.tapError((error) =>
          Effect.logError("Run-host hard kill failed", {
            attemptId,
            worker: active.worker,
            host: active.host,
            reason,
            message: String(error),
          }),
        ),
        Effect.ignore,
      );
      yield* Effect.logWarning("Run-host hard-kill signal sent", {
        attemptId,
        worker: active.worker,
        host: active.host,
        reason,
      });
    });

    const cancelActive = Effect.fn("RunHostSession.cancelActive")(function* (
      attemptId: Attempt.AttemptId,
      active: ActiveAttempt,
    ) {
      return yield* Effect.uninterruptible(
        Effect.gen(function* () {
          yield* Effect.annotateCurrentSpan({
            attemptId,
            worker: active.worker,
            host: active.host,
          });
          const first = yield* Ref.modify(
            active.cancelStarted,
            (started) => [!started, true] as const,
          );
          if (!first) {
            yield* Effect.logDebug("Attempt cancellation was already started", {
              attemptId,
              worker: active.worker,
              host: active.host,
            });
            return;
          }
          yield* Effect.logInfo("Sending the interrupt envelope", {
            attemptId,
            worker: active.worker,
            host: active.host,
          });
          const sequence = yield* Ref.getAndUpdate(active.sequence, (value) => value + 1);
          const envelope = new AttemptChannel.InboundEnvelope({
            version: AttemptChannel.PROTOCOL_VERSION,
            attemptId,
            sequence: AttemptChannel.Sequence.make(sequence),
            sentAt: yield* DateTime.now,
            payload: new AttemptChannel.Interrupt(),
          });
          const delivered = yield* active.io.append("inbound", envelope).pipe(
            Effect.andThen(Queue.offer(active.input, frame(envelope))),
            // The transcript store is outside the process adapter and may be
            // parked. Bound it so the uninterruptible cancellation handshake
            // always reaches the hard-kill phase.
            Effect.timeoutOption(options.interruptGrace),
            Effect.result,
          );
          if (Result.isFailure(delivered)) {
            yield* Effect.logWarning("Interrupt could not be delivered", {
              attemptId,
              worker: active.worker,
              host: active.host,
              message: String(delivered.failure),
            });
            yield* hardKill(attemptId, active, "delivery-failed");
            return yield* delivered.failure;
          }
          if (Option.isNone(delivered.success)) {
            const cause = new Error("interrupt delivery exceeded the cancellation grace");
            yield* Effect.logWarning("Interrupt delivery timed out", {
              attemptId,
              worker: active.worker,
              host: active.host,
            });
            yield* hardKill(attemptId, active, "delivery-failed");
            return yield* cancelError(attemptId, cause);
          }
          const completed = yield* active.handle.exitCode.pipe(
            Effect.timeoutOption(options.interruptGrace),
          );
          if (Option.isNone(completed)) {
            yield* Effect.logWarning("Interrupt grace expired", {
              attemptId,
              worker: active.worker,
              host: active.host,
            });
            yield* hardKill(attemptId, active, "grace-expired");
          } else {
            yield* Effect.logInfo("Run host stopped within the interrupt grace", {
              attemptId,
              worker: active.worker,
              host: active.host,
            });
          }
        }),
      );
    });

    const cancel = Effect.fn("RunHostSession.cancel")(function* (attemptId: Attempt.AttemptId) {
      const active = (yield* Ref.get(activeAttempts)).get(attemptId);
      if (active === undefined) {
        yield* Effect.logDebug("Attempt cancellation was a no-op", { attemptId });
        return;
      }
      yield* cancelActive(attemptId, active).pipe(
        Effect.mapError((cause) =>
          isExecutorError(cause) ? cause : cancelError(attemptId, cause),
        ),
      );
    });

    const launch = Effect.fn("RunHostSession.launch")(function* (
      prepared: PreparedAttempt,
      io: AttemptChannel.Sink,
    ) {
      const attemptId = prepared.spec.attemptId;
      yield* Effect.annotateCurrentSpan({ attemptId, worker: prepared.worker });

      const execute = Effect.scoped(
        Effect.gen(function* () {
          const input = yield* Queue.make<Uint8Array, Cause.Done>();
          const { handle, host, scrub } = yield* options.spawn(prepared, input);
          yield* Effect.annotateCurrentSpan({ host });
          const active: ActiveAttempt = {
            cancelStarted: yield* Ref.make(false),
            handle,
            host,
            input,
            io,
            sequence: yield* Ref.make(1),
            worker: prepared.worker,
          };
          yield* Ref.update(activeAttempts, (current) => {
            const next = new Map(current);
            next.set(attemptId, active);
            return next;
          });
          yield* Queue.offer(
            input,
            frame(
              new AttemptChannel.Start({
                version: AttemptChannel.PROTOCOL_VERSION,
                spec: prepared.spec,
              }),
            ),
          );

          const stderr = yield* Ref.make("");
          const stderrFiber = yield* handle.stderr.pipe(
            Stream.decodeText(),
            Stream.runForEach((chunk) =>
              Ref.update(stderr, (current) => `${current}${chunk}`.slice(-STDERR_TAIL_BYTES)),
            ),
            Effect.forkChild,
          );
          const terminal = yield* Ref.make(
            Option.none<
              AttemptChannel.Final | AttemptChannel.Failed | AttemptChannel.Interrupted
            >(),
          );
          const progress = yield* Ref.make(AttemptChannel.initialProgress);

          yield* handle.stdout.pipe(
            Stream.decodeText(),
            Stream.splitLines,
            Stream.runForEach((rawLine) =>
              Effect.gen(function* () {
                // Protocol v2 carries raw tool inputs and outputs; scrub the
                // credential from the line before it is decoded or persisted.
                const line = scrub(rawLine);
                const envelope = yield* decodeOutboundEnvelope(line).pipe(
                  Effect.catch((cause) => {
                    const diagnostic = invalidFrameDiagnostic(line, cause);
                    return Effect.logError("Run host emitted an invalid frame", {
                      attemptId,
                      ...diagnostic,
                    }).pipe(
                      Effect.andThen(
                        Effect.fail(infrastructureFailure(invalidFrameMessage(diagnostic), cause)),
                      ),
                    );
                  }),
                );
                const admitted = AttemptChannel.admit(
                  yield* Ref.get(progress),
                  attemptId,
                  envelope,
                );
                if (Result.isFailure(admitted)) return yield* violationFailure(admitted.failure);
                yield* Ref.set(progress, admitted.success);
                yield* io.append("outbound", envelope);
                const payload = envelope.payload;
                if (
                  payload._tag === "Final" ||
                  payload._tag === "Failed" ||
                  payload._tag === "Interrupted"
                ) {
                  yield* Effect.logInfo("Run host reached its terminal envelope", {
                    attemptId,
                    terminal: payload._tag,
                    sequence: envelope.sequence,
                  });
                  yield* Ref.set(terminal, Option.some(payload));
                  yield* Queue.end(input);
                }
              }),
            ),
            Effect.mapError((error) =>
              Schema.is(AttemptFailure.AttemptFailure)(error)
                ? error
                : infrastructureFailure("The run-host channel failed", error),
            ),
          );
          const exitCode = yield* handle.exitCode.pipe(
            Effect.mapError((cause) =>
              infrastructureFailure("Could not read the run-host exit code", cause),
            ),
          );
          yield* Fiber.join(stderrFiber).pipe(
            Effect.tapError((error) =>
              Effect.logWarning("Could not finish reading run-host stderr", {
                attemptId,
                message: String(error),
              }),
            ),
            Effect.ignore,
          );
          yield* Effect.logInfo("Run host exited", {
            attemptId,
            exitCode: String(exitCode),
          });
          const ended = yield* Ref.get(terminal);
          const errorOutput = scrub((yield* Ref.get(stderr)).trim());
          if (Option.isNone(ended)) {
            return yield* infrastructureFailure(
              "The run-host channel closed without a final envelope",
              new Error(`run host exited with code ${String(exitCode)}: ${errorOutput}`),
            );
          }
          if (ended.value._tag === "Failed") return yield* ended.value.failure;
          if (ended.value._tag === "Interrupted") {
            return yield* new AttemptFailure.AgentFailure({
              message: "The run host confirmed the interrupt and stopped",
            });
          }
          if (Number(exitCode) !== 0) {
            return yield* infrastructureFailure(
              `The run host exited with code ${String(exitCode)} after its final envelope`,
              new Error(errorOutput),
            );
          }
          return ended.value.result;
        }).pipe(
          Effect.onInterrupt(() =>
            cancel(attemptId).pipe(
              Effect.tapError((error) =>
                Effect.logWarning("Cancel-on-interrupt failed", {
                  attemptId,
                  message: String(error),
                }),
              ),
              Effect.ignore,
            ),
          ),
        ),
      );

      return yield* execute.pipe(
        Effect.ensuring(
          Ref.update(activeAttempts, (current) => {
            const next = new Map(current);
            next.delete(attemptId);
            return next;
          }),
        ),
        Effect.mapError((error) =>
          Schema.is(AttemptFailure.AttemptFailure)(error)
            ? error
            : infrastructureFailure("The executor failed while running the run host", error),
        ),
      );
    });

    return { cancel, launch } satisfies RunHostSession;
  });

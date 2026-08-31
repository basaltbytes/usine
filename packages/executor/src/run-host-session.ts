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
  Scope,
  Stream,
  type PlatformError,
} from "effect";
import type { ChildProcessHandle } from "effect/unstable/process/ChildProcessSpawner";
import { ExecutorError, ExecutorOperationError, type PreparedAttempt } from "./index.ts";

export interface SpawnedRunHost {
  readonly handle: ChildProcessHandle;
  readonly scrubStderr: (text: string) => string;
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
  readonly input: Queue.Queue<Uint8Array, Cause.Done>;
  readonly io: AttemptChannel.Sink;
  readonly sequence: Ref.Ref<number>;
}

const STDERR_TAIL_BYTES = 4_096;
const inputFrameToJson = Schema.encodeSync(AttemptChannel.InputFrameFromJson);
/** Strict by contract: an unknown key on a protocol frame is a rejected frame. */
const decodeOutboundEnvelope = (line: string) =>
  Schema.decodeUnknownEffect(AttemptChannel.OutboundEnvelopeFromJson)(line, {
    onExcessProperty: "error",
  });
const isExecutorError = Schema.is(ExecutorError);
const encoder = new TextEncoder();

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

    const cancelActive = Effect.fn("RunHostSession.cancelActive")(function* (
      attemptId: Attempt.AttemptId,
      active: ActiveAttempt,
    ) {
      return yield* Effect.uninterruptible(
        Effect.gen(function* () {
          const first = yield* Ref.modify(
            active.cancelStarted,
            (started) => [!started, true] as const,
          );
          if (!first) {
            yield* Effect.logDebug("Attempt cancellation was already started", {
              attemptId,
            });
            return;
          }
          yield* Effect.logInfo("Sending the interrupt envelope", { attemptId });
          const sequence = yield* Ref.getAndUpdate(active.sequence, (value) => value + 1);
          const envelope = new AttemptChannel.InboundEnvelope({
            version: AttemptChannel.PROTOCOL_VERSION,
            attemptId,
            sequence: AttemptChannel.Sequence.make(sequence),
            sentAt: yield* DateTime.now,
            payload: new AttemptChannel.Interrupt(),
          });
          yield* active.io.append("inbound", envelope).pipe(
            Effect.andThen(Queue.offer(active.input, frame(envelope))),
            Effect.catch((error) =>
              Effect.logWarning("Interrupt could not be delivered; killing the run host", {
                attemptId,
                message: String(error),
              }).pipe(
                Effect.andThen(
                  active.handle.kill({ killSignal: "SIGKILL" }).pipe(
                    Effect.tapError((killError) =>
                      Effect.logError("Run-host hard kill failed after interrupt delivery failed", {
                        attemptId,
                        message: String(killError),
                      }),
                    ),
                    Effect.ignore,
                  ),
                ),
                Effect.andThen(Effect.fail(error)),
              ),
            ),
          );
          const completed = yield* active.handle.exitCode.pipe(
            Effect.timeoutOption(options.interruptGrace),
          );
          if (Option.isNone(completed) && (yield* active.handle.isRunning)) {
            yield* Effect.logWarning("Interrupt grace expired; killing the run host", {
              attemptId,
            });
            yield* active.handle.kill({ killSignal: "SIGKILL" });
          } else {
            yield* Effect.logInfo("Run host stopped within the interrupt grace", {
              attemptId,
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
          const { handle, scrubStderr } = yield* options.spawn(prepared, input);
          const active: ActiveAttempt = {
            cancelStarted: yield* Ref.make(false),
            handle,
            input,
            io,
            sequence: yield* Ref.make(1),
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
            Stream.runForEach((line) =>
              Effect.gen(function* () {
                const envelope = yield* decodeOutboundEnvelope(line).pipe(
                  Effect.mapError((cause) =>
                    infrastructureFailure("The run host emitted an invalid frame", cause),
                  ),
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
          const errorOutput = scrubStderr((yield* Ref.get(stderr)).trim());
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

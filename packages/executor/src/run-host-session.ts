import * as AttemptChannel from "@usine/core/attempt/channel";
import { AgentFailure, AttemptFailure, InfraFailure } from "@usine/core/attempt/failure";
import { AttemptId } from "@usine/core/attempt";
import { StepResult } from "@usine/core/step/result";
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
import { ExecutorError, ExecutorOperationError, type AttemptWorkspace } from "./executor.ts";
import { invalidFrameDiagnostic, invalidFrameMessage } from "./invalid-frame.ts";

interface SpawnedRunHost {
  readonly handle: ChildProcessHandle;
  readonly host: string;
  /** Redacts the Attempt credential from run-host output before it is persisted. */
  readonly scrub: (text: string) => string;
}

export type RunHostInput = Queue.Queue<Uint8Array, Cause.Done>;

export interface RunHostSessionOptions {
  readonly interruptGrace: Parameters<typeof Effect.timeoutOption>[1];
}

type SpawnRunHost = (
  input: RunHostInput,
) => Effect.Effect<SpawnedRunHost, AttemptFailure | PlatformError.PlatformError, Scope.Scope>;

export interface RunHostSession {
  readonly cancel: (attemptId: AttemptId) => Effect.Effect<void, ExecutorError>;
  readonly launch: (
    prepared: AttemptWorkspace,
    io: AttemptChannel.Sink,
    spawn: SpawnRunHost,
  ) => Effect.Effect<StepResult, AttemptFailure>;
}

interface ActiveAttempt {
  readonly cancelStarted: Ref.Ref<boolean>;
  readonly handle: ChildProcessHandle;
  readonly host: string;
  readonly input: Queue.Queue<Uint8Array, Cause.Done>;
  readonly io: AttemptChannel.Sink;
  readonly sequence: Ref.Ref<number>;
  readonly worker: AttemptWorkspace["worker"];
}

const STDERR_TAIL_BYTES = 4_096;
/** Sending SIGKILL is its own bounded step, unrelated to the interrupt grace. */
const KILL_TIMEOUT = "5 seconds";
const inputFrameToJson = Schema.encodeSync(AttemptChannel.InputFrameFromJson);
/** Rejects a frame with any unknown key; the protocol is strict by contract. */
const decodeOutboundEnvelope = (line: string) =>
  Schema.decodeUnknownEffect(AttemptChannel.OutboundEnvelopeFromJson)(line, {
    onExcessProperty: "error",
  });
const isExecutorError = Schema.is(ExecutorError);
const encoder = new TextEncoder();

const frame = (input: AttemptChannel.InputFrame): Uint8Array =>
  encoder.encode(`${inputFrameToJson(input)}\n`);

const infrastructureFailure = (message: string, cause: unknown) =>
  new InfraFailure({ message, cause });

const violationFailure = (violation: AttemptChannel.Violation) =>
  infrastructureFailure(violation.message, new Error(violation.detail));

const cancelError = (attemptId: AttemptId, cause: unknown) =>
  new ExecutorOperationError({
    operation: "cancel",
    message: `Could not cancel Attempt ${attemptId}`,
    cause,
  });

/** The run-host byte-channel session every process-backed Executor shares. */
export const runHostSessionFor: (options: RunHostSessionOptions) => Effect.Effect<RunHostSession> =
  Effect.fn("RunHostSession.for")(function* (options: RunHostSessionOptions) {
    const activeAttempts = yield* Ref.make(new Map<AttemptId, ActiveAttempt>());

    const hardKill = Effect.fn("RunHostSession.hardKill")(function* (
      attemptId: AttemptId,
      active: ActiveAttempt,
      reason: "delivery-failed" | "grace-expired",
    ) {
      yield* Effect.logWarning("Hard-killing the run host", {
        attemptId,
        worker: active.worker,
        host: active.host,
        reason,
      });
      // The kill failure is logged, never propagated, so it cannot mask the
      // failure that forced the hard kill.
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
      attemptId: AttemptId,
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
            // The transcript store sits outside the process adapter and may be
            // parked; the bound keeps the uninterruptible cancellation handshake
            // moving on to the hard kill.
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

    const cancel = Effect.fn("RunHostSession.cancel")(function* (attemptId: AttemptId) {
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
      prepared: AttemptWorkspace,
      io: AttemptChannel.Sink,
      spawn: SpawnRunHost,
    ) {
      const attemptId = prepared.spec.attemptId;
      yield* Effect.annotateCurrentSpan({ attemptId, worker: prepared.worker });

      const execute = Effect.scoped(
        Effect.gen(function* () {
          const input = yield* Queue.make<Uint8Array, Cause.Done>();
          const { handle, host, scrub } = yield* spawn(input);
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
                // Frames include raw tool inputs and outputs; scrub the credential
                // from the line before it is decoded or persisted.
                const line = scrub(rawLine);
                const decoded = yield* decodeOutboundEnvelope(line).pipe(Effect.result);
                if (Result.isFailure(decoded)) {
                  const diagnostic = invalidFrameDiagnostic(line, decoded.failure);
                  if (diagnostic.source === "effect-log") {
                    yield* Effect.logWarning("Dropped a run-host diagnostic from protocol output", {
                      attemptId,
                      ...diagnostic,
                    });
                    return;
                  }
                  yield* Effect.logError("Run host emitted an invalid frame", {
                    attemptId,
                    ...diagnostic,
                  });
                  return yield* infrastructureFailure(
                    invalidFrameMessage(diagnostic),
                    decoded.failure,
                  );
                }
                const envelope = decoded.success;
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
              Schema.is(AttemptFailure)(error)
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
            return yield* new AgentFailure({
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
          Schema.is(AttemptFailure)(error)
            ? error
            : infrastructureFailure("The executor failed while running the run host", error),
        ),
      );
    });

    return { cancel, launch } satisfies RunHostSession;
  });

import {
  AgentRuntime,
  type ChildSessions,
  LaunchRequest,
  type RunningSession,
  toAttemptFailure,
  WorkingDirectory,
} from "@usine/agents/runtime";
import { AgentSessionId } from "@usine/core/agent/session";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { harvestFacts } from "@usine/core/step/harvest";
import { StepResult } from "@usine/core/step/result";
import {
  DateTime,
  Effect,
  Fiber,
  Queue,
  Path,
  Ref,
  Result,
  Schema,
  Semaphore,
  Stdio,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

/** The run host could not read its instructions, report activity, or collect the Attempt's Git results. */
export class RunHostError extends Schema.TaggedError<RunHostError>("@usine/run-host/RunHostError")(
  "RunHostError",
  {
    stage: Schema.Literals(["input", "output", "git", "github"]),
    message: Schema.NonEmptyString,
    cause: Schema.Defect(),
  },
) {}

/** Rejects a frame with any unknown key; the protocol is strict by contract. */
const decodeInput = (line: string) =>
  Schema.decodeUnknownEffect(AttemptChannel.InputFrameFromJson)(line, {
    onExcessProperty: "error",
  });
const encodeOutput = Schema.encodeSync(Schema.fromJsonString(AttemptChannel.OutboundEnvelope));

const hostError = (stage: RunHostError["stage"], message: string, cause: unknown): RunHostError =>
  new RunHostError({ stage, message, cause });

/** Hosts one Attempt described by the Start frame on stdin, sending session activity and its final outcome on stdout. */
export const runHost = Effect.fn("RunHost.run")(() =>
  Effect.scoped(
    Effect.gen(function* () {
      const agents = yield* AgentRuntime;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const stdio = yield* Stdio.Stdio;
      const path = yield* Path.Path;
      const frames = yield* Queue.make<AttemptChannel.InputFrame, RunHostError>();
      const input = stdio.stdin.pipe(
        Stream.mapError((cause) => hostError("input", "Could not read protocol input", cause)),
        Stream.decodeText(),
        Stream.splitLines,
        Stream.runForEach((line) =>
          decodeInput(line).pipe(
            Effect.mapError((cause) => hostError("input", "Invalid protocol input frame", cause)),
            Effect.flatMap((decoded) => Queue.offer(frames, decoded)),
          ),
        ),
        Effect.andThen(
          Queue.fail(
            frames,
            hostError(
              "input",
              "The protocol input channel closed before the run host finished",
              new Error("unexpected end of input"),
            ),
          ),
        ),
        Effect.catch((error) => Queue.fail(frames, error)),
      );
      yield* Effect.forkScoped(input);

      const first = yield* Queue.take(frames);
      if (first._tag !== "Start") {
        return yield* hostError(
          "input",
          "The first protocol frame must be Start",
          new Error(first._tag),
        );
      }
      const spec = first.spec;
      yield* Effect.annotateCurrentSpan({
        agent: spec.agent.name,
        attemptId: spec.attemptId,
        repository: spec.repository,
      });
      yield* Effect.logInfo("Run host accepted the Start frame");
      // The lifecycle has one writer at a time: Started, session events, terminal.
      let nextSequence = 1;

      const outputLock = yield* Semaphore.make(1);
      const routing = yield* Semaphore.make(1);
      const emit = Effect.fn("RunHost.emit")(
        function* (payload: AttemptChannel.OutboundPayload) {
          yield* Effect.annotateCurrentSpan({ attemptId: spec.attemptId });
          const envelope = new AttemptChannel.OutboundEnvelope({
            version: AttemptChannel.PROTOCOL_VERSION,
            attemptId: spec.attemptId,
            sequence: AttemptChannel.Sequence.make(nextSequence++),
            sentAt: yield* DateTime.now,
            payload,
          });
          yield* Stream.run(
            Stream.make(`${encodeOutput(envelope)}\n`),
            stdio.stdout({ endOnDone: false }),
          );
        },
        Effect.mapError((cause) => hostError("output", "Could not write protocol output", cause)),
        outputLock.withPermits(1),
      );

      const commandLines = Effect.fn("RunHost.commandLines")(function* (
        command: "git" | "gh",
        args: ReadonlyArray<string>,
      ) {
        const stage = command === "git" ? "git" : "github";
        return yield* Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* spawner.spawn(ChildProcess.make(command, args));
            const stderrFiber = yield* handle.stderr.pipe(
              Stream.decodeText(),
              Stream.mkString,
              Effect.forkChild,
            );
            const lines = yield* handle.stdout.pipe(
              Stream.decodeText(),
              Stream.splitLines,
              Stream.runCollect,
            );
            const exitCode = yield* handle.exitCode;
            const stderr = yield* Fiber.join(stderrFiber);
            if (Number(exitCode) !== 0) {
              return yield* hostError(
                stage,
                `${command} exited with code ${String(exitCode)}`,
                new Error(stderr.trim()),
              );
            }
            return lines;
          }),
        ).pipe(
          Effect.mapError((cause) =>
            cause instanceof RunHostError
              ? cause
              : hostError(stage, `Could not inspect Attempt results with ${command}`, cause),
          ),
        );
      });

      const harvest = Effect.fn("RunHost.harvest")(function* () {
        yield* Effect.annotateCurrentSpan({
          attemptId: spec.attemptId,
          repository: spec.repository,
        });
        return yield* harvestFacts(spec, commandLines).pipe(
          Effect.catchTag("HarvestError", (error) =>
            Effect.fail(hostError(error.stage, error.message, error.cause)),
          ),
        );
      });

      // The parent and each live child are addressable by the id they report in
      // the event stream, so an inbound frame can steer or interrupt one directly.
      const sessions = yield* Ref.make(new Map<AgentSessionId, RunningSession>());
      const record = (target: RunningSession) =>
        Ref.update(sessions, (current) => new Map(current).set(target.session.id, target));
      const childSessions: ChildSessions = {
        register: (child) =>
          record(child).pipe(
            Effect.andThen(
              Effect.addFinalizer(() =>
                Ref.update(sessions, (current) => {
                  const next = new Map(current);
                  next.delete(child.session.id);
                  return next;
                }),
              ),
            ),
          ),
      };

      const launched = yield* Effect.result(
        agents.launch(
          new LaunchRequest({
            spec,
            cwd: WorkingDirectory.make(path.resolve(".")),
          }),
          childSessions,
        ),
      );
      if (Result.isFailure(launched)) {
        yield* Effect.logError("Agent session failed to launch", {
          errorTag: launched.failure._tag,
          message: launched.failure.message,
        });
        yield* emit(new AttemptChannel.Failed({ failure: toAttemptFailure(launched.failure) }));
        return;
      }
      const session = launched.success;
      yield* record(session);
      yield* emit(new AttemptChannel.Started({ parentModel: session.session.brain.model }));

      const route = Effect.fn("RunHost.route")(function* (
        envelope: AttemptChannel.InboundEnvelope,
        action: AttemptChannel.OperatorAction,
      ) {
        const targetId =
          envelope.target._tag === "Parent" ? session.session.id : envelope.target.sessionId;
        yield* Effect.annotateCurrentSpan({ attemptId: spec.attemptId, target: targetId });
        const intervention = new AttemptChannel.Intervention({
          operator: envelope.operator,
          target: envelope.target,
          action,
        });
        const controls = (yield* Ref.get(sessions)).get(targetId);
        if (
          controls === undefined ||
          (envelope.target._tag === "Child" && controls.session._tag !== "ChildSession")
        ) {
          yield* Effect.logWarning("Operator input addressed a session that is no longer live", {
            target: targetId,
            action: action._tag,
          });
          return yield* emit(
            new AttemptChannel.InterventionRejected({
              inputSequence: envelope.sequence,
              intervention,
              message: "This session is no longer live",
            }),
          );
        }
        const delivered = yield* Effect.result(controls.intervene(action));
        if (Result.isFailure(delivered)) {
          yield* Effect.logWarning("Session refused operator input", {
            target: targetId,
            errorTag: delivered.failure._tag,
            message: delivered.failure.message,
          });
          return yield* emit(
            new AttemptChannel.InterventionRejected({
              inputSequence: envelope.sequence,
              intervention,
              message: delivered.failure.message,
            }),
          );
        }
        yield* emit(
          new AttemptChannel.InterventionApplied({
            inputSequence: envelope.sequence,
            intervention,
            state: delivered.success,
          }),
        );
      }, routing.withPermits(1));
      const readCommands = Effect.gen(function* () {
        let expected = 1;
        while (true) {
          const command = yield* Queue.take(frames);
          if (command._tag === "Start") {
            return yield* hostError(
              "input",
              "The run host received a second Start frame",
              new Error("duplicate Start"),
            );
          }
          if (command.attemptId !== spec.attemptId) {
            return yield* hostError(
              "input",
              "The run host received a command for another Attempt",
              new Error(String(command.attemptId)),
            );
          }
          if (command.sequence !== expected) {
            return yield* hostError(
              "input",
              "The run host received a non-contiguous input sequence",
              new Error(`expected ${expected}, received ${command.sequence}`),
            );
          }
          expected += 1;
          if (command.payload._tag === "Cancel") {
            yield* Effect.logInfo("Run host received a Cancel frame");
            return new AttemptChannel.Interrupted();
          }
          yield* route(command, command.payload);
        }
      });

      const completed = Effect.gen(function* () {
        // Both must finish before harvesting; either failure ends the Attempt
        // even when the SDK leaves the other channel open.
        const [sessionResult] = yield* Effect.all(
          [
            session.result,
            session.events.pipe(
              Stream.runForEach((event) => emit(new AttemptChannel.SessionEvent({ event }))),
            ),
          ],
          { concurrency: "unbounded" },
        ).pipe(Effect.onExit(() => routing.withPermits(1)(Effect.void)));
        // Successful and failed completions both wait for an in-flight receipt.
        const facts = yield* harvest();
        return new AttemptChannel.Final({
          result: new StepResult({
            message: sessionResult.message,
            facts,
          }),
        });
      });
      const outcome = yield* Effect.raceFirst(completed, readCommands).pipe(Effect.result);
      yield* routing.withPermits(1)(Effect.void);
      if (Result.isFailure(outcome)) {
        if (outcome.failure._tag === "RunHostError") {
          yield* Effect.logError("Run host protocol failure", {
            stage: outcome.failure.stage,
            message: outcome.failure.message,
          });
          return yield* outcome.failure;
        }
        yield* Effect.logError("Agent session failed", {
          errorTag: outcome.failure._tag,
          message: outcome.failure.message,
        });
        yield* emit(new AttemptChannel.Failed({ failure: toAttemptFailure(outcome.failure) }));
        return;
      }
      if (outcome.success._tag === "Interrupted") {
        // The race has stopped result collection and event forwarding. An SDK
        // that fails its result on abort can no longer change this outcome.
        yield* Effect.forkScoped(
          session.interrupt.pipe(
            Effect.tapError((error) =>
              Effect.logWarning("Session interrupt delivery failed", {
                attemptId: spec.attemptId,
                repository: spec.repository,
                errorTag: error._tag,
                message: error.message,
              }),
            ),
            Effect.ignore,
          ),
          { startImmediately: true },
        );
        yield* Effect.logInfo("Run host acknowledged the interrupted session");
      } else {
        yield* Effect.logInfo("Run host completed the Attempt", {
          facts: outcome.success.result.facts.length,
        });
      }
      yield* emit(outcome.success);
    }),
  ),
);

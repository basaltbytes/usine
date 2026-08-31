/** @usine/run-host — one-shot worker-side Attempt host. */

import { AgentRuntime, LaunchRequest, toAttemptFailure, WorkingDirectory } from "@usine/agents";
import { AttemptChannel, Repository, StepResult } from "@usine/core";
import {
  Deferred,
  DateTime,
  Effect,
  Fiber,
  Queue,
  Ref,
  Result,
  Schema,
  Semaphore,
  Stdio,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

export class RunHostError extends Schema.TaggedError<RunHostError>("@usine/run-host/RunHostError")(
  "RunHostError",
  {
    stage: Schema.Literals(["input", "output", "git"]),
    message: Schema.NonEmptyString,
    cause: Schema.Defect(),
  },
) {}

/** Strict by contract: an unknown key on a protocol frame is a rejected frame. */
const decodeInput = (line: string) =>
  Schema.decodeUnknownEffect(AttemptChannel.InputFrameFromJson)(line, {
    onExcessProperty: "error",
  });
const encodeOutput = Schema.encodeSync(Schema.fromJsonString(AttemptChannel.OutboundEnvelope));

const hostError = (stage: RunHostError["stage"], message: string, cause: unknown): RunHostError =>
  new RunHostError({ stage, message, cause });

/** Runs one real agent session over the strict protocol-v2 newline-delimited channel. */
export const runHost = () =>
  Effect.scoped(
    Effect.gen(function* () {
      const agents = yield* AgentRuntime;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const stdio = yield* Stdio.Stdio;
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
      const inputFiber = yield* Effect.forkChild(input);

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
      const sequence = yield* Ref.make(1);
      const outputLock = yield* Semaphore.make(1);

      const emit = Effect.fn("RunHost.emit")(
        function* (payload: AttemptChannel.OutboundPayload) {
          yield* outputLock.withPermit(
            Effect.gen(function* () {
              const next = yield* Ref.getAndUpdate(sequence, (value) => value + 1);
              const envelope = new AttemptChannel.OutboundEnvelope({
                version: AttemptChannel.PROTOCOL_VERSION,
                attemptId: spec.attemptId,
                sequence: AttemptChannel.Sequence.make(next),
                sentAt: yield* DateTime.now,
                payload,
              });
              yield* Stream.run(
                Stream.make(`${encodeOutput(envelope)}\n`),
                stdio.stdout({ endOnDone: false }),
              );
            }),
          );
        },
        Effect.mapError((cause) => hostError("output", "Could not write protocol output", cause)),
      );

      const gitLines = Effect.fn("RunHost.gitLines")(function* (args: ReadonlyArray<string>) {
        return yield* Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* spawner.spawn(ChildProcess.make("git", args));
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
                "git",
                `git exited with code ${String(exitCode)}`,
                new Error(stderr.trim()),
              );
            }
            return lines;
          }),
        ).pipe(
          Effect.mapError((cause) =>
            cause instanceof RunHostError
              ? cause
              : hostError("git", "Could not inspect Attempt commits", cause),
          ),
        );
      });

      const harvestCommits = Effect.fn("RunHost.harvestCommits")(function* () {
        const lines = yield* gitLines([
          "log",
          "--reverse",
          "--format=%H%x00%s",
          `${spec.baseCommit}..HEAD`,
        ]);
        return yield* Effect.forEach(lines, (line) =>
          Effect.gen(function* () {
            const separator = line.indexOf("\u0000");
            const sha = yield* Schema.decodeUnknownEffect(Repository.CommitSha)(
              separator < 0 ? line : line.slice(0, separator),
            ).pipe(
              Effect.mapError((cause) =>
                hostError("git", "git returned an invalid commit id", cause),
              ),
            );
            const summary = separator < 0 ? "" : line.slice(separator + 1).trim();
            if (summary.length === 0) {
              return yield* hostError(
                "git",
                `Commit ${sha} has no summary`,
                new Error("empty commit summary"),
              );
            }
            return new StepResult.Commit({ sha, summary });
          }),
        );
      });

      yield* emit(new AttemptChannel.Started());
      const launched = yield* Effect.result(
        agents.launch(
          new LaunchRequest({
            spec,
            cwd: WorkingDirectory.make(process.cwd()),
          }),
        ),
      );
      if (Result.isFailure(launched)) {
        yield* Effect.logError("Agent session failed to launch", {
          errorTag: launched.failure._tag,
          message: launched.failure.message,
        });
        yield* emit(new AttemptChannel.Failed({ failure: toAttemptFailure(launched.failure) }));
        yield* Fiber.interrupt(inputFiber);
        return;
      }
      const session = launched.success;
      const eventFiber = yield* session.events.pipe(
        Stream.runForEach((event) => emit(new AttemptChannel.SessionEvent({ event }))),
        Effect.forkChild,
      );
      const interrupted = yield* Deferred.make<void>();
      const expectedInputSequence = yield* Ref.make(1);
      const readCommands = Effect.forever(
        Effect.gen(function* () {
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
          const expected = yield* Ref.get(expectedInputSequence);
          if (command.sequence !== expected) {
            return yield* hostError(
              "input",
              "The run host received a non-contiguous input sequence",
              new Error(`expected ${expected}, received ${command.sequence}`),
            );
          }
          yield* Ref.set(expectedInputSequence, expected + 1);
          if (command.payload._tag === "Interrupt") {
            yield* Effect.logInfo("Run host received an Interrupt frame");
            // Start delivery before waking the terminal race. The SDK's native
            // promise keeps carrying the interrupt even when terminal cleanup
            // interrupts this command fiber immediately afterward.
            yield* Effect.forkChild(session.interrupt);
            yield* Deferred.succeed(interrupted, undefined);
          } else {
            yield* Effect.logDebug("Run host received a Steer frame");
            yield* session.steer(command.payload.message);
          }
        }),
      );
      const commandFiber = yield* Effect.forkChild(readCommands);

      const completed = Effect.gen(function* () {
        const sessionResult = yield* session.result;
        yield* Fiber.join(eventFiber);
        const commits = yield* harvestCommits();
        return new StepResult.StepResult({ message: sessionResult.message, facts: commits });
      });
      yield* Effect.gen(function* () {
        const outcome = yield* Effect.raceFirst(
          Effect.race(
            completed.pipe(Effect.map((value) => ({ _tag: "Completed" as const, value }))),
            Deferred.await(interrupted).pipe(Effect.as({ _tag: "Interrupted" as const })),
          ),
          Effect.andThen(Fiber.join(commandFiber), Effect.never),
        ).pipe(Effect.result);
        if (Result.isFailure(outcome)) {
          if (Schema.is(RunHostError)(outcome.failure)) {
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
          yield* Effect.logInfo("Run host acknowledged the interrupted session");
          yield* emit(new AttemptChannel.Interrupted());
          return;
        }
        yield* Effect.logInfo("Run host completed the Attempt", {
          commits: outcome.success.value.facts.length,
        });
        yield* emit(new AttemptChannel.Final({ result: outcome.success.value }));
      }).pipe(
        Effect.ensuring(
          Effect.all(
            [
              Fiber.interrupt(commandFiber),
              Fiber.interrupt(eventFiber),
              Fiber.interrupt(inputFiber),
            ],
            { discard: true },
          ),
        ),
      );
    }),
  );

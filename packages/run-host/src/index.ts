/** @usine/run-host — one-shot worker-side Attempt host. */

import { AttemptChannel, AttemptFailure, Repository, StepResult } from "@usine/core";
import {
  Deferred,
  DateTime,
  Effect,
  Fiber,
  Queue,
  Ref,
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

export interface RunHostOptions {
  readonly stubDelayMillis?: number;
}

const decodeInput = Schema.decodeUnknownEffect(AttemptChannel.InputFrameFromJson);
const encodeOutput = Schema.encodeSync(Schema.fromJsonString(AttemptChannel.OutboundEnvelope));

const hostError = (stage: RunHostError["stage"], message: string, cause: unknown): RunHostError =>
  new RunHostError({ stage, message, cause });

/** Runs one stub agent session over protocol-v1 newline-delimited stdio. */
export const runHost = (options: RunHostOptions = {}) =>
  Effect.gen(function* () {
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
          yield* Deferred.succeed(interrupted, undefined);
        } else {
          yield* emit(
            new AttemptChannel.AgentMessage({
              message: `Steer received: ${command.payload.message}`,
            }),
          );
        }
      }),
    );
    const commandFiber = yield* Effect.forkChild(readCommands);

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
      const shas = yield* gitLines(["rev-list", "--reverse", `${spec.baseCommit}..HEAD`]);
      return yield* Effect.forEach(shas, (value) =>
        Effect.gen(function* () {
          const sha = yield* Schema.decodeUnknownEffect(Repository.CommitSha)(value).pipe(
            Effect.mapError((cause) =>
              hostError("git", "git returned an invalid commit id", cause),
            ),
          );
          const summaries = yield* gitLines(["show", "-s", "--format=%s", sha]);
          const summary = summaries[0]?.trim();
          if (summary === undefined || summary.length === 0) {
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
    yield* emit(new AttemptChannel.AgentMessage({ message: `Working on ${spec.task}` }));

    const completed = Effect.gen(function* () {
      const delay = options.stubDelayMillis ?? 0;
      if (delay > 0) yield* Effect.sleep(`${delay} millis`);
      const commits = yield* harvestCommits();
      return new StepResult.StepResult({
        message: `Completed: ${spec.task}`,
        facts: commits,
      });
    });
    yield* Effect.gen(function* () {
      const result = yield* Effect.raceFirst(
        Effect.race(
          completed.pipe(Effect.map((value) => ({ _tag: "Completed" as const, value }))),
          Deferred.await(interrupted).pipe(Effect.as({ _tag: "Interrupted" as const })),
        ),
        Effect.andThen(Fiber.join(commandFiber), Effect.never),
      );
      if (result._tag === "Interrupted") {
        yield* emit(
          new AttemptChannel.Failed({
            failure: new AttemptFailure.AgentFailure({ message: "Attempt interrupted" }),
          }),
        );
        return;
      }
      yield* emit(new AttemptChannel.Final({ result: result.value }));
    }).pipe(
      Effect.ensuring(
        Effect.all([Fiber.interrupt(commandFiber), Fiber.interrupt(inputFiber)], {
          discard: true,
        }),
      ),
    );
  });

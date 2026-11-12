import { assert } from "@effect/vitest";
import {
  type Cause,
  Deferred,
  Effect,
  Exit,
  Option,
  Predicate,
  Queue,
  Ref,
  Schema,
  Scope,
  Sink,
  Stream,
} from "effect";
import { ChildProcessSpawner } from "effect/process";
import { AgentSessionId } from "@usine/core/agent/session";
import { RemoteShell } from "../../src/child-host/child-host.ts";
import { startChildProcess } from "../../src/child-host/node.ts";
import { claudeOutputCheckpoint } from "../../src/harness/claude/sdk.ts";
import { ChildSessionLifecycle } from "../../src/runtime.ts";

const decodeOwnerInput = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      sequence: Schema.optionalKey(Schema.Int),
      data: Schema.optionalKey(Schema.String),
      checkpoint: Schema.optionalKey(Schema.Boolean),
      offset: Schema.optionalKey(Schema.Int),
      skip: Schema.optionalKey(Schema.Int),
    }),
  ),
);
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Json));

/** Encodes `message` as one newline-terminated JSON line. */
export const jsonLine = (message: Schema.Json) =>
  encodeJson(message).pipe(
    Effect.orDie,
    Effect.map((text) => Buffer.from(`${text}\n`)),
  );

/** Writes one owner relay frame to the orchestrator. */
export type OwnerFrame = (value: Schema.Json) => Effect.Effect<boolean>;

/**
 * An owner relay that writes `initial`, passes each input frame to `onInput`, and confirms
 * checkpoints. `frame` writes further frames; `saved` holds the confirmed detach checkpoint.
 */
export const scriptedOwner = (
  initial: ReadonlyArray<Schema.Json>,
  onInput: (sequence: number, frame: OwnerFrame) => Effect.Effect<unknown>,
) =>
  Effect.gen(function* () {
    const ownerOutput = yield* Queue.unbounded<Uint8Array, Cause.Done>();
    const frame: OwnerFrame = (value) =>
      jsonLine(value).pipe(Effect.flatMap((line) => Queue.offer(ownerOutput, line)));
    const saved = yield* Deferred.make<{ readonly offset: number; readonly skip: number }>();
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        assert(command._tag === "StandardCommand");
        const stdin = command.options.stdin;
        assert(Predicate.hasProperty(stdin, "stream") && Stream.isStream(stdin.stream));
        for (const value of initial) yield* frame(value);
        yield* stdin.stream.pipe(
          Stream.decodeText(),
          Stream.splitLines,
          Stream.drop(1),
          Stream.mapEffect((text) => decodeOwnerInput(text)),
          Stream.runForEach((input) =>
            Effect.gen(function* () {
              if (input.data !== undefined && input.sequence !== undefined)
                yield* onInput(input.sequence, frame);
              if (
                input.checkpoint === true &&
                input.offset !== undefined &&
                input.skip !== undefined
              ) {
                yield* Deferred.succeed(saved, { offset: input.offset, skip: input.skip });
                yield* frame({ offset: 40, checkpoint: true });
              }
            }),
          ),
          Effect.orDie,
          Effect.forkScoped,
        );
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(4242),
          exitCode: Effect.never,
          isRunning: Effect.succeed(true),
          kill: () => Effect.void,
          stdin: Sink.drain,
          stdout: Stream.fromQueue(ownerOutput),
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void),
        });
      }),
    );
    return { spawner, saved, frame };
  });

/** A remote child target for a `scriptedOwner` spawner. */
export const scriptedTarget = {
  host: RemoteShell.make({
    ssh: { command: "ssh", args: [] },
    sshEnvironment: {},
    destination: "worker",
  }),
  cwd: "/worktree",
  environment: {},
  sessionId: Option.some(AgentSessionId.make("attempt:child:1")),
};

/** The harness command for `scriptedTarget`. */
export const scriptedCommand = { command: "claude", args: [], cwd: "/worktree" };

/**
 * Reads a Claude hook request from a scripted owner, sends the hook response as the input chunks
 * that `split` returns, and detaches once `onInput` runs `responded`. `onInput` scripts the owner's
 * handling of each input frame. Returns the checkpoint that the owner saved while detaching, or
 * fails with `TimeoutError` if none arrives within one second.
 */
export const detachAfterHookResponse = (
  onInput: (
    sequence: number,
    frame: OwnerFrame,
    responded: Effect.Effect<void>,
  ) => Effect.Effect<unknown>,
  split: (response: Buffer) => ReadonlyArray<Uint8Array>,
) =>
  Effect.gen(function* () {
    const hook = yield* jsonLine({
      type: "control_request",
      request_id: "hook",
      request: { subtype: "hook_callback" },
    });
    const response = yield* jsonLine({
      type: "control_response",
      response: { request_id: "hook", subtype: "success" },
    });
    const responded = yield* Deferred.make<void>();
    const { spawner, saved } = yield* scriptedOwner(
      [
        { offset: 10, ready: true, sequence: 0, retained: false },
        { offset: 20, stdout: hook.toString("base64") },
      ],
      (sequence, frame) =>
        onInput(sequence, frame, Deferred.succeed(responded, undefined).pipe(Effect.asVoid)),
    );
    const stopping = yield* Ref.make(false);
    const input = yield* Queue.unbounded<Uint8Array, Cause.Done>();
    const hookRead = yield* Deferred.make<void>();
    const checkpoint = yield* claudeOutputCheckpoint();
    const scope = yield* Scope.make();
    yield* Effect.gen(function* () {
      const owner = yield* startChildProcess(
        scriptedTarget,
        scriptedCommand,
        Stream.fromQueue(input),
        { acknowledgement: "handled", onInputAcknowledged: checkpoint.inputAcknowledged },
      );
      yield* owner.stdout.pipe(
        Stream.runForEach((bytes) =>
          checkpoint
            .read(bytes)
            .pipe(
              Effect.flatMap(owner.acknowledgeOutput),
              Effect.andThen(Deferred.succeed(hookRead, undefined)),
            ),
        ),
        Effect.forkScoped,
      );
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(ChildSessionLifecycle, { isStopping: Ref.get(stopping) }),
      Scope.provide(scope),
    );
    yield* Deferred.await(hookRead);
    yield* Queue.offerAll(input, split(response));
    yield* Deferred.await(responded);
    yield* Ref.set(stopping, true);
    yield* Scope.close(scope, Exit.void);
    return yield* Deferred.await(saved).pipe(Effect.timeout("1 second"));
  });

import { assert } from "@effect/vitest";
import { AgentName } from "@usine/core/agent";
import type { BrainSpec } from "@usine/core/agent/brain";
import { AgentSessionId, ChildSession, type AgentSessionEvent } from "@usine/core/agent/session";
import {
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Option,
  Path,
  type PlatformError,
  Result,
  Stream,
} from "effect";
import {
  ChildRequest,
  type ChildBackendService,
  type RunningSession,
  WorkingDirectory,
} from "../../src/runtime.ts";

// The test controls when the command can finish; model/network latency cannot
// race a fixed sleep. A broken test still releases the process within a minute.
const waitScript = `import { existsSync } from 'node:fs';
const timer = setInterval(() => {
  if (existsSync('release')) { clearInterval(timer); process.exit(0); }
}, 25);
setTimeout(() => process.exit(1), 60000).unref();
`;

const controlledChild = <A, E, R>(
  backend: ChildBackendService,
  brain: BrainSpec,
  use: (
    running: RunningSession,
    release: Effect.Effect<void, PlatformError.PlatformError>,
  ) => Effect.Effect<A, E, R>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: `usine-${brain.harness}-live-` });
      yield* fs.writeFileString(path.join(cwd, "wait-for-release.mjs"), waitScript);
      const running = yield* backend.launch(
        new ChildRequest({
          cwd: WorkingDirectory.make(cwd),
          session: new ChildSession({
            id: AgentSessionId.make(`${brain.harness}-live-child`),
            parentId: AgentSessionId.make(`${brain.harness}-live-parent`),
            agent: AgentName.make("contract-tester"),
            brain,
          }),
          prompt:
            "Run exactly `node ./wait-for-release.mjs` using your command tool. Wait for it to exit. Then reply with exactly ORIGINAL_INSTRUCTION. Do not run any other commands or change files.",
        }),
      );
      const started = yield* Deferred.make<void>();
      const events: Array<AgentSessionEvent> = [];
      const collected = yield* running.events.pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            events.push(event);
            if (
              event._tag === "ToolStarted" &&
              JSON.stringify(event.input).includes("wait-for-release.mjs")
            ) {
              yield* Deferred.succeed(started, undefined);
            }
          }),
        ),
        Effect.result,
        Effect.forkChild,
      );
      yield* Deferred.await(started).pipe(Effect.timeout("90 seconds"));
      const result = yield* use(running, fs.writeFileString(path.join(cwd, "release"), "ready"));
      const stream = yield* Fiber.join(collected).pipe(Effect.timeout("15 seconds"));
      assert.strictEqual(events.at(0)?._tag, "SessionStarted");
      return { result, events, stream };
    }),
  );

export const steeringContract = (backend: ChildBackendService, brain: BrainSpec) =>
  controlledChild(backend, brain, (running, release) =>
    Effect.gen(function* () {
      const marker = `STEER_${globalThis.crypto.randomUUID().replaceAll("-", "")}`;
      yield* running.steer(
        `Change the final reply: after the command exits, reply with exactly ${marker}.`,
      );
      yield* release;
      const result = yield* running.result.pipe(Effect.timeout("90 seconds"));
      assert(
        result.message.includes(marker),
        "the child must follow guidance sent during the active turn",
      );
    }),
  ).pipe(
    Effect.map(({ events, stream }) => {
      assert(Result.isSuccess(stream), "successful work must close the event stream successfully");
      assert.strictEqual(events.at(-1)?._tag, "SessionFinished");
      assert(events.some((event) => event._tag === "TextOutput"));
      if (brain.harness === "codex") {
        const snapshots = events.filter((event) => event._tag === "PoolRateLimitsUpdated");
        assert(
          snapshots.some(
            (event) =>
              event.pool === "chatgptPlan" &&
              (Option.isSome(event.rateLimits.primary) ||
                Option.isSome(event.rateLimits.secondary)),
          ),
          "the real Codex CLI must provide at least one rate window",
        );
      }
    }),
  );

export const interruptionContract = (backend: ChildBackendService, brain: BrainSpec) =>
  controlledChild(backend, brain, (running) =>
    Effect.gen(function* () {
      yield* running.interrupt.pipe(Effect.timeout("15 seconds"));
      const result = yield* running.result.pipe(Effect.result, Effect.timeout("15 seconds"));
      if (Result.isFailure(result)) assert.strictEqual(result.failure._tag, "AgentResultError");
      else
        assert(
          !result.success.message.includes("ORIGINAL_INSTRUCTION"),
          "the waiting command must not complete normally after interrupt",
        );
      return result;
    }),
  ).pipe(
    Effect.map(({ result, events, stream }) => {
      assert.strictEqual(
        stream._tag,
        result._tag,
        "result and event stream must agree on interruption",
      );
      assert(
        !events.some(
          (event) => event._tag === "TextOutput" && event.text.includes("ORIGINAL_INSTRUCTION"),
        ),
      );
    }),
  );

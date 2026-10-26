import { assert, describe, it } from "@effect/vitest";
import { RemoteShell } from "@usine/agents/child-host";
import { ClaudeSdk, claudeChildLayer } from "@usine/agents/claude";
import { ChildBackend, ChildRequest, WorkingDirectory } from "@usine/agents/runtime";
import { AgentName } from "@usine/core/agent";
import { BrainSpec, ModelId } from "@usine/core/agent/brain";
import { AgentSessionId, ChildSession } from "@usine/core/agent/session";
import { MachineId, WorkerName } from "@usine/core/worker";
import { type Cause, Effect, Fiber, Layer, Option, Queue, type Schema, Stream } from "effect";
import { claudeLoginLockLayer } from "../src/executor.ts";

/** The checkout of `attempt` on its machine of the provisioned Worker. */
const checkout = (attempt: string) => `/home/usine/.usine/workers/provisioned/attempts/${attempt}`;

/** Child `child` of `attempt`, on the machine with provider ID `machine` that the Worker created for it. */
const claudeChild = (machine: string, attempt: string, child: number) =>
  new ChildRequest({
    session: new ChildSession({
      id: AgentSessionId.make(`parent:${attempt}:child:${String(child)}`),
      parentId: AgentSessionId.make(`parent:${attempt}`),
      agent: AgentName.make("developer"),
      brain: new BrainSpec({
        harness: "claude",
        model: ModelId.make("claude-sonnet-4-6"),
        effort: "high",
      }),
    }),
    cwd: WorkingDirectory.make(checkout(attempt)),
    prompt: "Implement the focused task.",
    environment: { HOME: "/home/usine", PATH: "/usr/bin:/bin" },
    host: new RemoteShell({
      ssh: { command: "ssh", args: ["-o", "BatchMode=yes"] },
      sshEnvironment: {},
      destination: `usine@machine-${machine}`,
    }),
    worker: WorkerName.make("provisioned"),
    machine: Option.some(MachineId.make(machine)),
  });

/** The event that shows Claude's first API request succeeded with a working login. */
const rateLimitEvent = { type: "rate_limit_event", rate_limit_info: { status: "allowed" } };

describe("Claude login lock", () => {
  it.effect(
    "starts Claude children on two machines of a provisioned Worker at once, and children on one machine one at a time",
    () =>
      Effect.gen(function* () {
        // Each Claude process shows nothing until the test sends its output, so it keeps its lock.
        const launches: Array<{
          readonly cwd: string | undefined;
          readonly output: Queue.Queue<Schema.Json, Cause.Done>;
        }> = [];
        const context = yield* Effect.context<never>();
        const sdk = Layer.succeed(ClaudeSdk)({
          open: (_input, options) => {
            const output = Effect.runSyncWith(context)(Queue.make<Schema.Json, Cause.Done>());
            launches.push({ cwd: options.cwd, output });
            const messages = Stream.toAsyncIterableWith(Stream.fromQueue(output), context);
            return {
              close: () => {
                Effect.runForkWith(context)(Queue.end(output));
              },
              interrupt: () => Promise.resolve(),
              supportedModels: () => Promise.resolve([{ value: "claude-sonnet-4-6" }]),
              [Symbol.asyncIterator]: () => messages[Symbol.asyncIterator](),
            };
          },
        });
        yield* Effect.gen(function* () {
          const backend = yield* ChildBackend;
          const first = yield* Effect.forkChild(backend.launch(claudeChild("52341896", "a1", 1)));
          while (launches.length < 1) yield* Effect.yieldNow;
          const sameMachine = yield* Effect.forkChild(
            backend.launch(claudeChild("52341896", "a1", 2)),
          );
          const otherMachine = yield* Effect.forkChild(
            backend.launch(claudeChild("52341897", "a2", 1)),
          );
          while (launches.length < 2) yield* Effect.yieldNow;
          assert.deepStrictEqual(
            launches.map(({ cwd }) => cwd),
            [checkout("a1"), checkout("a2")],
            "the child on the other machine starts while the first child holds its machine's lock, and the second child on that machine waits",
          );
          yield* Queue.offer(launches[0]!.output, rateLimitEvent);
          while (launches.length < 3) yield* Effect.yieldNow;
          assert.strictEqual(launches[2]!.cwd, checkout("a1"));
          yield* Effect.forEach(launches.slice(1), ({ output }) =>
            Queue.offer(output, rateLimitEvent),
          );
          yield* Fiber.joinAll([first, sameMachine, otherMachine]);
        }).pipe(
          Effect.provide(claudeChildLayer.pipe(Layer.provide(claudeLoginLockLayer))),
          Effect.provide(sdk),
          Effect.scoped,
        );
      }),
  );
});

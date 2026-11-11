import { assert, describe, it } from "@effect/vitest";
import type { TaskId } from "@earendil-works/pi-durable";
import { ChildBackend } from "@usine/agents/runtime";
import { AgentSessionId, ChildSessionBudget, ChildSessionCount } from "@usine/core/agent/session";
import { Deferred, Effect, Fiber, Option } from "effect";
import { delegate } from "../src/attempt/delegation/delegation.ts";
import { attemptHubs } from "../src/attempt/hubs.ts";
import { stubChildBackendLayer, StubChildren } from "../src/testing.ts";
import { memoryJournal } from "./memory-journal.ts";
import { attemptRequest } from "./support.ts";

// SAFETY: the hub uses the task ID only as a lookup key; no durable task backs these tests.
const ATTEMPT_TASK = 1 as TaskId;

/** Starts one delegation with an attached `execute` call and returns its fiber. */
const start = (attemptId: string, memory: ReturnType<typeof memoryJournal>, maxChildren = 3) =>
  Effect.gen(function* () {
    const request = attemptRequest(attemptId, maxChildren);
    const hubs = yield* attemptHubs;
    const hub = yield* hubs.hub(request.spec.attemptId, ATTEMPT_TASK);
    yield* Deferred.succeed(hub.attached, request);
    const backend = yield* ChildBackend;
    const fiber = yield* Effect.forkChild(
      delegate(
        { hubs, backend },
        { spec: request.spec, hub, journal: memory.journal, assignment: "Finish the task" },
      ),
    );
    return { fiber, hub };
  });

describe("delegate", () => {
  it.effect("returns the child's final message as Reported", () =>
    Effect.gen(function* () {
      const memory = memoryJournal();
      const { fiber, hub } = yield* start("delegation/reported", memory);
      const child = yield* (yield* StubChildren).next;
      yield* child.reply("Finished.");
      const outcome = yield* Fiber.join(fiber);

      assert.deepStrictEqual(outcome, {
        _tag: "Reported",
        sessionId: child.request.session.id,
        report: "Finished.",
      });
      assert.strictEqual(memory.attempt.children, 1);
      assert.deepStrictEqual(memory.delegation.count, Option.some(1));
      assert.strictEqual(memory.delegation.output, "Finished.\n");
      assert.deepStrictEqual(memory.published, [{ childSessionId: child.request.session.id }]);
      assert.isFalse(hub.children.has(child.request.session.id));
    }).pipe(Effect.provide(stubChildBackendLayer)),
  );

  it.effect("returns a reserved report as Reserved and records it as the child blocker", () =>
    Effect.gen(function* () {
      const memory = memoryJournal();
      const { fiber } = yield* start("delegation/reserved", memory);
      const child = yield* (yield* StubChildren).next;
      yield* child.block("The repository is archived.");
      const outcome = yield* Fiber.join(fiber);

      assert.strictEqual(outcome._tag, "Reserved");
      if (outcome._tag !== "Reserved") return;
      assert.strictEqual(outcome.sessionId, child.request.session.id);
      assert.strictEqual(outcome.report._tag, "AgentBlockedError");
      assert.strictEqual(outcome.report.message, "The repository is archived.");
      assert.deepStrictEqual(
        memory.attempt.blocker,
        Option.some({
          sessionId: child.request.session.id,
          message: "The repository is archived.",
          kind: "blocked" as const,
        }),
      );
    }).pipe(Effect.provide(stubChildBackendLayer)),
  );

  it.effect("keeps the Attempt's first reserved report when a later child also reserves one", () =>
    Effect.gen(function* () {
      const first = {
        sessionId: "parent:delegation/first-report:child:1",
        message: "The repository is archived.",
        kind: "blocked" as const,
      };
      const memory = memoryJournal();
      memory.attempt.children = 1;
      memory.attempt.blocker = Option.some(first);
      const { fiber } = yield* start("delegation/first-report", memory);
      const child = yield* (yield* StubChildren).next;
      yield* child.ask("Which branch should I use?");
      const outcome = yield* Fiber.join(fiber);

      assert.strictEqual(outcome._tag, "Reserved");
      if (outcome._tag !== "Reserved") return;
      assert.strictEqual(outcome.sessionId, child.request.session.id);
      assert.strictEqual(outcome.report._tag, "AgentQuestionError");
      assert.strictEqual(outcome.report.message, "Which branch should I use?");
      assert.deepStrictEqual(memory.attempt.blocker, Option.some(first));
    }).pipe(Effect.provide(stubChildBackendLayer)),
  );

  it.effect("returns Interrupted for a resumed delegation without a saved conversation", () =>
    Effect.gen(function* () {
      const sessionId = AgentSessionId.make("parent:delegation/interrupted:child:1");
      const memory = memoryJournal();
      memory.attempt.children = 1;
      memory.attempt.held = [sessionId];
      memory.delegation.count = Option.some(1);
      memory.delegation.output = "Partial work\n";
      const { fiber, hub } = yield* start("delegation/interrupted", memory);
      const outcome = yield* Fiber.join(fiber);

      assert.deepStrictEqual(outcome, {
        _tag: "Interrupted",
        sessionId,
        reason: "the child did not commit a saved conversation",
        output: "Partial work\n",
      });
      assert.deepStrictEqual(memory.attempt.held, []);
      assert.strictEqual(memory.attempt.children, 1);
      assert.strictEqual(hub.childSpawns.size, 0);
    }).pipe(Effect.provide(stubChildBackendLayer)),
  );

  it.effect("returns BudgetExceeded without launching a child past the budget", () =>
    Effect.gen(function* () {
      const memory = memoryJournal();
      memory.attempt.children = 1;
      const { fiber, hub } = yield* start("delegation/budget", memory, 1);
      const outcome = yield* Fiber.join(fiber);

      assert.deepStrictEqual(outcome, {
        _tag: "BudgetExceeded",
        attempted: ChildSessionCount.make(2),
        max: ChildSessionBudget.make(1),
      });
      assert.deepStrictEqual(memory.attempt.refused, Option.some({ attempted: 2, max: 1 }));
      assert.deepStrictEqual(memory.delegation.count, Option.some(2));
      assert.strictEqual(hub.childSpawns.size, 0);
    }).pipe(Effect.provide(stubChildBackendLayer)),
  );

  it.effect("fails a fresh delegation whose child ends without a report", () =>
    Effect.gen(function* () {
      const memory = memoryJournal();
      const { fiber } = yield* start("delegation/crashed", memory);
      const child = yield* (yield* StubChildren).next;
      yield* child.crash("unexpected end of output");
      const error = yield* Fiber.join(fiber).pipe(Effect.flip);

      assert.strictEqual(error._tag, "SessionOperationError");
      assert.deepStrictEqual(
        memory.attempt.blocker,
        Option.some({
          sessionId: child.request.session.id,
          message: "unexpected end of output",
          kind: "infra" as const,
        }),
      );
    }).pipe(Effect.provide(stubChildBackendLayer)),
  );
});

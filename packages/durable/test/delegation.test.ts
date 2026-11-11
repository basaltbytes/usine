import { assert, describe, it } from "@effect/vitest";
import type { TaskId } from "@earendil-works/pi-durable";
import { ChildBackend } from "@usine/agents/runtime";
import { AgentSessionId, ChildSessionBudget, ChildSessionCount } from "@usine/core/agent/session";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { Deferred, Effect, Fiber, Option } from "effect";
import { delegate } from "../src/attempt/delegation/delegation.ts";
import { attemptHubs } from "../src/attempt/hubs.ts";
import { stubChildBackendLayer, StubChildren } from "../src/testing.ts";
import { memoryJournal } from "./memory-journal.ts";
import { attemptRequest } from "./support.ts";

// SAFETY: the hub uses the task ID only as a lookup key; no durable task backs these tests.
const ATTEMPT_TASK = 1 as TaskId;

/**
 * Starts one delegation with an attached `execute` call and returns its fiber. With `hubs`, the
 * delegation joins the Attempt's existing hub, as a parallel delegation of the same Attempt does.
 */
const start = (
  attemptId: string,
  memory: ReturnType<typeof memoryJournal>,
  options: {
    readonly maxChildren?: number;
    readonly hubs?: Effect.Success<typeof attemptHubs>;
  } = {},
) =>
  Effect.gen(function* () {
    const request = attemptRequest(attemptId, options.maxChildren ?? 3);
    const hubs = options.hubs ?? (yield* attemptHubs);
    const hub = yield* hubs.hub(request.spec.attemptId, ATTEMPT_TASK);
    yield* Deferred.succeed(hub.attached, request);
    const backend = yield* ChildBackend;
    const fiber = yield* Effect.forkChild(
      delegate(
        { hubs, backend },
        { spec: request.spec, hub, journal: memory.journal, assignment: "Finish the task" },
      ),
    );
    return { fiber, hub, hubs };
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

  it.live("keeps the child's report from the parent until the operator's Hold ends", () =>
    Effect.gen(function* () {
      const sessionId = AgentSessionId.make("parent:delegation/held:child:1");
      const memory = memoryJournal();
      memory.attempt.held = [sessionId];
      const { fiber, hub } = yield* start("delegation/held", memory);
      const child = yield* (yield* StubChildren).next;
      assert.strictEqual(child.request.session.id, sessionId);
      yield* child.reply("Finished.");
      // Release the child alone: its result resolves while the journal still records the Hold.
      const running = hub.children.get(sessionId);
      assert.isDefined(running);
      if (running === undefined) return;
      yield* running.intervene(AttemptChannel.Release.make(), () => Effect.void);
      const early = yield* Fiber.join(fiber).pipe(Effect.timeoutOption("300 millis"));
      assert.isTrue(Option.isNone(early));

      yield* memory.release(sessionId);
      const outcome = yield* Fiber.join(fiber);
      assert.deepStrictEqual(outcome, { _tag: "Reported", sessionId, report: "Finished." });
    }).pipe(Effect.provide(stubChildBackendLayer), Effect.timeout("10 seconds")),
  );

  it.effect(
    "keeps the Attempt's first infrastructure failure when a parallel child also crashes",
    () =>
      Effect.gen(function* () {
        const first = memoryJournal();
        const second = memoryJournal(first.attempt);
        const children = yield* StubChildren;
        const one = yield* start("delegation/two-crashes", first);
        const firstChild = yield* children.next;
        const two = yield* start("delegation/two-crashes", second, { hubs: one.hubs });
        const secondChild = yield* children.next;

        yield* firstChild.crash("first transport lost");
        yield* Fiber.join(one.fiber).pipe(Effect.flip);
        yield* secondChild.crash("second transport lost");
        const error = yield* Fiber.join(two.fiber).pipe(Effect.flip);

        assert.strictEqual(error._tag, "SessionOperationError");
        assert.strictEqual(first.attempt.children, 2);
        assert.deepStrictEqual(
          first.attempt.blocker,
          Option.some({
            sessionId: firstChild.request.session.id,
            message: "first transport lost",
            kind: "infra" as const,
          }),
        );
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
      const { fiber, hub } = yield* start("delegation/budget", memory, { maxChildren: 1 });
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

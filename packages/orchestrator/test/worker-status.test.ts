import { assert, describe, it } from "@effect/vitest";
import { BrainSpec, type Harness, ModelId } from "@usine/core/agent/brain";
import { HarnessUnavailableError } from "@usine/core/agent/capability";
import { WorkerName } from "@usine/core/worker";
import { ExecutorOperationError, WorkerCapabilityError } from "@usine/executor";
import { DateTime, Option } from "effect";
import { recordPreflight, unchecked, type WorkerPreflight } from "../src/worker-status.ts";

const worker = WorkerName.make("local");
const brain = (harness: Harness, model: string) =>
  new BrainSpec({ harness, model: ModelId.make(model), effort: "high" });
const codex = brain("codex", "gpt-5.6-sol");
const claude = brain("claude", "claude-opus-4-1");
const pi = brain("pi", "gpt-5.6-sol");
const at = (hour: number) =>
  DateTime.makeUnsafe(`2026-10-20T${String(hour).padStart(2, "0")}:00:00Z`);

const summary = (preflight: WorkerPreflight) => ({
  prerequisites: Option.match(preflight.prerequisites, {
    onNone: () => "unchecked",
    onSome: (check) => `${check._tag} ${DateTime.formatIso(check.checkedAt)}`,
  }),
  harnesses: preflight.harnesses.map(
    ({ harness, check }) => `${harness} ${check._tag} ${DateTime.formatIso(check.checkedAt)}`,
  ),
});

const notLoggedIn = (harness: Harness) =>
  new WorkerCapabilityError({
    worker,
    capability: "harness-login",
    message: `${harness} is not logged in`,
    cause: new HarnessUnavailableError({ harness, capability: "login", message: "not logged in" }),
  });

describe("Worker preflight record", () => {
  it("passes the Worker's prerequisites and every harness of a passed preflight", () => {
    const record = recordPreflight(unchecked(worker), [codex, claude], at(8), Option.none());
    assert.deepStrictEqual(summary(record), {
      prerequisites: "Passed 2026-10-20T08:00:00.000Z",
      harnesses: [
        "claude Passed 2026-10-20T08:00:00.000Z",
        "codex Passed 2026-10-20T08:00:00.000Z",
      ],
    });
  });

  it("fails an unavailable harness, passes the ones checked before it, and keeps the rest", () => {
    const started = recordPreflight(unchecked(worker), [pi], at(8), Option.none());
    const record = recordPreflight(
      started,
      [codex, claude, pi],
      at(9),
      Option.some(notLoggedIn("claude")),
    );
    assert.deepStrictEqual(summary(record), {
      prerequisites: "Passed 2026-10-20T08:00:00.000Z",
      harnesses: [
        "claude Failed 2026-10-20T09:00:00.000Z",
        "codex Passed 2026-10-20T09:00:00.000Z",
        "pi Passed 2026-10-20T08:00:00.000Z",
      ],
    });
    const failed = record.harnesses[0]?.check;
    assert(failed?._tag === "Failed", "claude failed");
    assert.deepStrictEqual(failed.capability, Option.some("harness-login"));
    assert.strictEqual(failed.message, "claude is not logged in");
  });

  it("fails the Worker's prerequisites on any other failure and leaves its harnesses", () => {
    const started = recordPreflight(unchecked(worker), [codex], at(8), Option.none());
    const memory = recordPreflight(
      started,
      [codex, claude],
      at(9),
      Option.some(
        new WorkerCapabilityError({
          worker,
          capability: "memory",
          message: "The machine has 2 GiB of memory, less than 1.5 GiB per Attempt.",
          cause: "MemTotal: 2097152 kB",
        }),
      ),
    );
    assert.deepStrictEqual(summary(memory), {
      prerequisites: "Failed 2026-10-20T09:00:00.000Z",
      harnesses: ["codex Passed 2026-10-20T08:00:00.000Z"],
    });
    const timedOut = recordPreflight(
      memory,
      [codex],
      at(10),
      Option.some(
        new ExecutorOperationError({
          operation: "preflight",
          message: "The harness probe timed out",
          cause: new Error("timeout"),
        }),
      ),
    );
    const prerequisites = Option.getOrUndefined(timedOut.prerequisites);
    assert(prerequisites?._tag === "Failed", "the probe failed");
    assert.isTrue(Option.isNone(prerequisites.capability));
    assert.strictEqual(prerequisites.message, "The harness probe timed out");
  });
});

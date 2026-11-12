import { assert, describe, it } from "@effect/vitest";
import { BrainSpec, Harness, ModelId } from "@usine/core/agent/brain";
import { HarnessUnavailableError } from "@usine/core/agent/capability";
import {
  ContainerCpus,
  ContainerLimits,
  ContainerMemoryMib,
  ContainerPids,
  WorkerName,
} from "@usine/core/worker";
import { ExecutorOperationError, fullPreflight, WorkerCapabilityError } from "@usine/executor";
import { DateTime, Option, Result } from "effect";
import { recordPreflight, unchecked, type WorkerPreflight } from "../src/worker-status.ts";

const worker = WorkerName.make("local");
const brain = (harness: Harness, model: string) =>
  BrainSpec.make({ harness, model: ModelId.make(model), effort: "high" });
const codex = brain(Harness.make("codex"), "gpt-5.6-sol");
const claude = brain(Harness.make("claude"), "claude-opus-4-1");
const pi = brain(Harness.make("pi"), "gpt-5.6-sol");
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
  WorkerCapabilityError.make({
    worker,
    capability: "harness-login",
    message: `${harness} is not logged in`,
    cause: HarnessUnavailableError.make({ harness, capability: "login", message: "not logged in" }),
  });

describe("Worker preflight record", () => {
  it("passes the Worker's prerequisites and every harness of a passed preflight", () => {
    const record = recordPreflight(
      unchecked(worker),
      [codex, claude],
      at(8),
      Result.succeed(fullPreflight),
    );
    assert.deepStrictEqual(summary(record), {
      prerequisites: "Passed 2026-10-20T08:00:00.000Z",
      harnesses: [
        "claude Passed 2026-10-20T08:00:00.000Z",
        "codex Passed 2026-10-20T08:00:00.000Z",
      ],
    });
  });

  it("records a degraded preflight on the Worker's prerequisites and passes its harnesses", () => {
    const record = recordPreflight(
      unchecked(worker),
      [codex],
      at(8),
      Result.succeed({
        ...fullPreflight,
        degraded: Option.some("Docker isn't installed"),
      }),
    );
    assert.deepStrictEqual(summary(record), {
      prerequisites: "Degraded 2026-10-20T08:00:00.000Z",
      harnesses: ["codex Passed 2026-10-20T08:00:00.000Z"],
    });
    const prerequisites = Option.getOrUndefined(record.prerequisites);
    assert(prerequisites?._tag === "Degraded", "degraded");
    assert.strictEqual(prerequisites.message, "Docker isn't installed");
  });

  it("keeps the container limits of the last machine check through a preflight without a machine", () => {
    const limits = ContainerLimits.make({
      cpus: ContainerCpus.make(3.5),
      memoryMib: ContainerMemoryMib.make(7168),
      pids: ContainerPids.make(60976),
    });
    const withoutMachine = {
      ...fullPreflight,
      deferred: Option.some("Checked on the worker's first machine each day."),
    };
    const started = recordPreflight(
      unchecked(worker),
      [codex],
      at(8),
      Result.succeed(withoutMachine),
    );
    assert.isTrue(Option.isNone(started.containerLimits));
    const checked = recordPreflight(
      started,
      [codex],
      at(9),
      Result.succeed({ ...fullPreflight, containerLimits: Option.some(limits) }),
    );
    const reloaded = recordPreflight(
      checked,
      [codex, claude],
      at(10),
      Result.succeed(withoutMachine),
    );
    assert.deepStrictEqual(reloaded.containerLimits, Option.some(limits));
  });

  it("keeps the findings of the last machine check through a preflight without a machine or a failed one", () => {
    const finding = "The SSH user can't read the kernel journal";
    const checked = recordPreflight(
      unchecked(worker),
      [codex],
      at(8),
      Result.succeed({ ...fullPreflight, findings: [finding] }),
    );
    assert.deepStrictEqual(checked.findings, [finding]);
    const deferred = recordPreflight(
      checked,
      [codex],
      at(9),
      Result.succeed({
        ...fullPreflight,
        deferred: Option.some("Checked on the worker's first machine each day."),
      }),
    );
    assert.deepStrictEqual(deferred.findings, [finding]);
    const failed = recordPreflight(
      deferred,
      [codex],
      at(10),
      Result.fail(
        WorkerCapabilityError.make({
          worker,
          capability: "machine",
          message: "Can't connect",
          cause: new Error("refused"),
        }),
      ),
    );
    assert.deepStrictEqual(failed.findings, [finding]);
    const fixed = recordPreflight(failed, [codex], at(11), Result.succeed(fullPreflight));
    assert.deepStrictEqual(fixed.findings, []);
  });

  it("fails an unavailable harness, passes the ones checked before it, and keeps the rest", () => {
    const finding = "The SSH user can't read the kernel journal";
    const started = recordPreflight(
      unchecked(worker),
      [pi],
      at(8),
      Result.succeed({ ...fullPreflight, findings: [finding] }),
    );
    const record = recordPreflight(
      started,
      [codex, claude, pi],
      at(9),
      Result.fail(notLoggedIn(Harness.make("claude"))),
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
    assert.deepStrictEqual(record.findings, [finding]);
  });

  it("fails the Worker's prerequisites on any other failure and leaves its harnesses", () => {
    const started = recordPreflight(
      unchecked(worker),
      [codex],
      at(8),
      Result.succeed(fullPreflight),
    );
    const memory = recordPreflight(
      started,
      [codex, claude],
      at(9),
      Result.fail(
        WorkerCapabilityError.make({
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
      Result.fail(
        ExecutorOperationError.make({
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

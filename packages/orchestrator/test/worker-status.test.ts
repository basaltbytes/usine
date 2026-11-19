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
import { fullPreflight, WorkerCapabilityError } from "@usine/executor";
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

  it("records the limits and findings of a machine check that deferred the harnesses", () => {
    const limits = ContainerLimits.make({
      cpus: ContainerCpus.make(2),
      memoryMib: ContainerMemoryMib.make(4096),
      pids: ContainerPids.make(4096),
    });
    const finding = "The SSH user can't read the kernel journal";
    const record = recordPreflight(
      unchecked(worker),
      [codex],
      at(9),
      Result.succeed({
        degraded: Option.none(),
        deferred: Option.some("Checked in the next attempt's container."),
        containerLimits: Option.some(limits),
        findings: [finding],
      }),
    );
    assert.deepStrictEqual(summary(record), {
      prerequisites: "Passed 2026-10-20T09:00:00.000Z",
      harnesses: ["codex Deferred 2026-10-20T09:00:00.000Z"],
    });
    assert.deepStrictEqual(record.containerLimits, Option.some(limits));
    assert.deepStrictEqual(record.findings, [finding]);
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
});

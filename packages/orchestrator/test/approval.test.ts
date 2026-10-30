import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { ManagedRepo } from "@usine/config/factory";
import { InstancePath } from "@usine/config/file";
import { LoopFile } from "@usine/config/loop";
import { ConfigParser } from "@usine/config/parser";
import { AttemptTask } from "@usine/core/attempt";
import { CycleGeneration } from "@usine/core/cycle-budget";
import { DedupKey } from "@usine/core/event";
import { InstanceDirectory } from "@usine/core/instance";
import { ItemKey } from "@usine/core/item";
import { RepositoryRevision } from "@usine/core/repository";
import { StepResult } from "@usine/core/step/result";
import { WorkerName } from "@usine/core/worker";
import { RunEngine } from "@usine/engine/engine";
import { layer, observationLayer } from "@usine/engine/local-sqlite";
import { RunReader } from "@usine/engine/run-reader";
import { StepExecutor } from "@usine/engine/step-executor";
import { ExpressionEngine } from "@usine/expression/expression-engine";
import { MarcbachmannCelLayer } from "@usine/expression/marcbachmann-cel";
import { DateTime, Effect, FileSystem, Layer, Logger, Option, Schema, Schedule } from "effect";
import { sqliteTempDirectory } from "../../../tooling/test/sqlite.mts";
import { triggerSubmission } from "../src/trigger-submission.ts";
import { runView } from "../src/operator/projection.ts";
import { alwaysHoldsLayer } from "./support/polling.ts";

const condition = 'item.labelEvents["ready-for-agent"].actor.type != "User"';
const label = (actor: Schema.Json) => ({
  labelEvents: { "ready-for-agent": { actor, createdAt: "2026-10-30T12:00:00Z" } },
});
const executor = Layer.succeed(StepExecutor)({
  workers: Effect.succeed([WorkerName.make("local")]),
  isLive: () => Effect.succeed(false),
  outcome: () => Effect.succeed(Option.none()),
  recover: () => Effect.void,
  intervene: () => Effect.void,
  interrupt: () => Effect.void,
  occupy: (worker) => Effect.succeed({ worker, release: Effect.void }),
  sweep: Effect.void,
  discard: () => Effect.void,
  reserve: () => Effect.succeed({ worker: WorkerName.make("local"), release: Effect.void }),
  execute: () => Effect.succeed(new StepResult({ message: "Completed", facts: [] })),
});
const parser = ConfigParser.layer.pipe(Layer.provideMerge(MarcbachmannCelLayer));

for (const scenario of [
  {
    name: "member label starts immediately",
    payload: label({ login: "alice", type: "User" }),
    approval: condition,
    state: "Succeeded",
    warning: false,
  },
  {
    name: "bot label requires approval",
    payload: label({ login: "usine-phildl", type: "Bot" }),
    approval: condition,
    state: "Waiting",
    warning: false,
  },
  {
    name: "missing label entry requires approval",
    payload: { labelEvents: {} },
    approval: condition,
    state: "Waiting",
    warning: true,
  },
  {
    name: "older payload requires approval",
    payload: {},
    approval: condition,
    state: "Waiting",
    warning: true,
  },
  {
    name: "deleted actor requires approval",
    payload: label(null),
    approval: condition,
    state: "Waiting",
    warning: true,
  },
  {
    name: "failed expression requires approval",
    payload: {},
    approval: "1 / 0 > 0",
    state: "Waiting",
    warning: true,
  },
  {
    name: "fixed required keeps the gate",
    payload: {},
    approval: "required",
    state: "Waiting",
    warning: false,
  },
  {
    name: "fixed none skips the gate",
    payload: {},
    approval: "none",
    state: "Succeeded",
    warning: false,
  },
]) {
  it.live(scenario.name, () => {
    const warnings: Array<string> = [];
    const logger = Logger.make<unknown, void>(({ logLevel, message }) => {
      if (logLevel === "Warn") warnings.push(JSON.stringify(message));
    });
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = InstanceDirectory.make(
        yield* fs.makeTempDirectoryScoped({
          directory: sqliteTempDirectory(),
          prefix: "usine-approval-",
        }),
      );
      const config = yield* ConfigParser;
      const expressions = yield* ExpressionEngine;
      const loop = yield* config.parseLoopFile(
        InstancePath.make("loops/start-dev.md"),
        `---\ntrigger: { on: issue, if: 'true' }\nagent: developer\napproval: '${scenario.approval}'\n---\nImplement.`,
      );
      const agent = yield* config.parseAgentFile(
        InstancePath.make("agents/developer.md"),
        "---\nharness: codex\nmodel: gpt-5.6-sol\neffort: high\n---\nImplement.",
      );
      const options = {
        loop,
        agent: agent.agent,
        repository: Schema.decodeUnknownSync(ManagedRepo)({ name: "acme/project" }),
        payload: Schema.decodeUnknownSync(Schema.Json)(scenario.payload),
        dedupKey: DedupKey.make("approval-event"),
        cycleGeneration: CycleGeneration.make(0),
        itemKey: ItemKey.make("github:acme/project:1"),
        receivedAt: DateTime.makeUnsafe("2026-10-30T12:00:00Z"),
        revision: RepositoryRevision.make("HEAD"),
        task: AttemptTask.make("Implement."),
        parentModel: Option.none(),
      };
      const submission = yield* triggerSubmission(expressions, options);
      const reason = Option.getOrNull(submission.approvalReason);
      expect(reason).toContain(
        scenario.state === "Waiting" ? "Approval required" : "Approval not required",
      );
      if (scenario.warning) expect(reason).toContain("could not be evaluated");
      if (scenario.name === "member label starts immediately")
        expect(reason).toContain("alice (User)");
      if (scenario.name === "bot label requires approval")
        expect(reason).toContain("usine-phildl (Bot)");
      expect(warnings.some((line) => line.includes("Approval evaluation failed"))).toBe(
        scenario.warning,
      );
      const runtime = layer(directory).pipe(
        Layer.provide(executor),
        Layer.provide(alwaysHoldsLayer),
      );
      const runId = yield* Effect.gen(function* () {
        const engine = yield* RunEngine;
        const submitted = yield* engine.submit(submission);
        if (submitted._tag !== "Claimed") return yield* Effect.die("run was not claimed");
        const inspect = engine.inspect(submitted.runId);
        const snapshot = yield* inspect.pipe(
          Effect.repeat({
            until: (snapshot) => snapshot.run.state._tag === scenario.state,
            schedule: Schedule.spaced("10 millis"),
          }),
          Effect.timeout("5 seconds"),
        );
        expect(snapshot.approvalReason).toEqual(submission.approvalReason);
        expect(snapshot.attempts).toHaveLength(scenario.state === "Waiting" ? 0 : 1);
        // A repeated event keeps the original decision after a configuration edit.
        const changed = yield* triggerSubmission(expressions, {
          ...options,
          loop: new LoopFile({ ...loop, approval: "required" }),
        });
        yield* engine.submit(changed);
        expect((yield* inspect).approvalReason).toEqual(submission.approvalReason);
        return submitted.runId;
      }).pipe(Effect.provide(runtime));
      yield* Effect.gen(function* () {
        const reader = yield* RunReader;
        const snapshot = yield* reader.inspect(runId);
        const [summary] = yield* reader.list({ closedLimit: 10 });
        expect(snapshot.approvalReason).toEqual(submission.approvalReason);
        expect(summary?.approvalReason).toEqual(submission.approvalReason);
        expect(runView(snapshot, new Set(), new Map()).approvalReason).toBe(
          Option.getOrNull(submission.approvalReason),
        );
      }).pipe(Effect.provide(observationLayer(directory)));
    }).pipe(
      Effect.provide(parser),
      Effect.provide(NodeServices.layer),
      Effect.provide(Logger.layer([logger])),
    );
  });
}

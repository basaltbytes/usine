import { assert, it } from "@effect/vitest";
import { AgentFile } from "@usine/config/agent";
import { UsineConfig } from "@usine/config/factory";
import { InstancePath } from "@usine/config/file";
import { ConfigParser } from "@usine/config/parser";
import { LoadedInstance } from "@usine/config/instance";
import { RunId } from "@usine/core/run";
import { Claimed, RunEngine, type Submission } from "@usine/engine/engine";
import { ItemProjection } from "@usine/engine/item-projection";
import { MarcbachmannCelLayer } from "@usine/expression/marcbachmann-cel";
import { Effect, Layer, Option, Schema } from "effect";
import { evaluateItem } from "../src/polling/loop-evaluation.ts";
import { resolveTriggerLoop } from "../src/trigger-submission.ts";

it.effect.each(["issue", "pr"] as const)(
  "pins each %s Event to its worker revision, including a later push",
  (source) =>
    Effect.gen(function* () {
      const config = Schema.decodeUnknownSync(UsineConfig)({
        version: 1,
        repos: [{ name: "acme/demo" }],
      });
      const repository = config.repos[0] ?? assert.fail("missing repository");
      const parser = yield* ConfigParser;
      const loop = yield* parser.parseLoopFile(
        InstancePath.make("loops/review.md"),
        `---\ntrigger:\n  on: ${source}\n  if: 'true'\nagent: reviewer\n---\nInspect item {{ item.number }}.`,
      );
      const agent = Schema.decodeUnknownSync(AgentFile)({
        name: "reviewer",
        harness: "codex",
        model: "gpt-5.6-sol",
        effort: "high",
        parentModel: Option.none(),
        parentEffort: Option.none(),
        persona: "Review the code.",
      });
      const instance = new LoadedInstance({
        config,
        agents: [agent],
        invalidAgents: [],
        loops: [loop],
        quarantinedLoops: [],
        warnings: [],
      });
      const resolved = yield* resolveTriggerLoop(instance, loop);
      const submissions: Array<Submission> = [];
      const engine = Layer.succeed(RunEngine)({
        approve: () => Effect.die("unused"),
        cancel: () => Effect.die("unused"),
        inspect: () => Effect.die("unused"),
        reconcile: () => Effect.die("unused"),
        retry: () => Effect.die("unused"),
        revoke: () => Effect.succeed([]),
        transcript: () => Effect.die("unused"),
        submit: (submission) =>
          Effect.sync(() => {
            submissions.push(submission);
            return new Claimed({
              eventId: submission.event.id,
              runId: RunId.make(submission.event.id),
            });
          }),
      });
      for (const digit of ["a", "b"]) {
        const sha = digit.repeat(40);
        const projection = Schema.decodeUnknownSync(ItemProjection)({
          repository: repository.name,
          source,
          number: 63,
          itemKey: "acme/demo/63",
          contentHash: digit.repeat(64),
          payload: { number: 63, ...(source === "pr" ? { headRefOid: sha } : {}) },
        });
        yield* evaluateItem(repository, [resolved], projection).pipe(Effect.provide(engine));
        assert.strictEqual(submissions.at(-1)?.revision, source === "pr" ? sha : "HEAD");
      }
      assert.strictEqual(submissions.length, 2);
      assert.notStrictEqual(submissions[0]?.event.id, submissions[1]?.event.id);
    }).pipe(Effect.provide(ConfigParser.layer.pipe(Layer.provideMerge(MarcbachmannCelLayer)))),
);

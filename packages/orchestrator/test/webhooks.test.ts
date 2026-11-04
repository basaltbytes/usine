import { InstanceScope } from "@usine/core/access";
import { ChangeBus, changeBusLayer } from "@usine/core/changes";
import { OperatorLogin } from "@usine/core/operator";
import { assert, it } from "@effect/vitest";
import { Effect, Option, Ref, Layer } from "effect";
import { TestClock } from "effect/testing";
import { AttentionAcknowledgement } from "@usine/engine/attention";
import { WebhookHealth } from "../src/webhooks.ts";
import { ReadyOverview } from "../src/operator/overview.ts";
import { webhookAttentionFor } from "../src/operator/webhooks.ts";
import { attentionKey } from "../src/operator/attention.ts";

it.effect(
  "warns at ten minutes only for endpoint mode, supports dismissal, and clears after a verified delivery",
  () =>
    Effect.gen(function* () {
      const fixtureValue1 = yield* Effect.context<never>();
      const runFixture = Effect.runSyncWith(fixtureValue1);

      const health = yield* WebhookHealth;
      const bus = yield* ChangeBus;
      const revision = (yield* bus.open).revision;
      const saved = yield* Ref.make<ReadonlyArray<AttentionAcknowledgement>>([]);
      const attention = webhookAttentionFor(health, { list: Ref.get(saved) });
      const overview = ReadyOverview.make({ projects: [], loops: [], needsYou: [] });
      const config = {
        mode: "endpoint",
        publicUrl: new URL("https://usine.example/webhooks/github"),
      } as const;
      const currentSilent = yield* health.silent;
      assert.isFalse(currentSilent);
      yield* TestClock.adjust("599 seconds");

      assert.deepStrictEqual((yield* attention(overview, config)).needsYou, []);
      yield* TestClock.adjust("1 second");
      const nextSilent = yield* health.silent;
      assert.isTrue(nextSilent);

      assert.strictEqual((yield* bus.open).revision, revision + 1);

      assert.deepStrictEqual((yield* bus.open).history.at(-1)?.changes, [
        { audience: InstanceScope.make(), target: { kind: "attention", id: "instance" } },
      ]);

      assert.deepStrictEqual((yield* attention(overview, { mode: "off" })).needsYou, []);

      assert.deepStrictEqual((yield* attention(overview, { mode: "deliveries" })).needsYou, []);
      const warning = yield* attention(overview, config);
      assert.strictEqual(warning.needsYou.length, 1);
      assert.strictEqual(warning.needsYou[0]?._tag, "WebhookSilenceNeed");
      yield* Ref.set(
        saved,
        warning.needsYou.map((need) =>
          AttentionAcknowledgement.make({
            ...runFixture(attentionKey(need)),
            dismissedBy: Option.some(OperatorLogin.make("operator")),
            dismissedAt: health.startedAt,
          }),
        ),
      );
      const dismissed = yield* attention(overview, config);
      assert.strictEqual(dismissed.needsYou.length, 0);
      assert.deepStrictEqual(dismissed.dismissedNeeds, warning.needsYou);
      yield* Ref.set(saved, []);

      assert.strictEqual((yield* attention(overview, config)).needsYou.length, 1);
      yield* health.received;

      assert.strictEqual((yield* bus.open).revision, revision + 2);
      yield* health.received;

      assert.strictEqual((yield* bus.open).revision, revision + 2);
      yield* TestClock.adjust("1 day");
      const updatedSilent = yield* health.silent;
      assert.isFalse(updatedSilent);

      assert.strictEqual((yield* bus.open).revision, revision + 2);

      assert.deepStrictEqual((yield* attention(overview, config)).needsYou, []);

      assert.deepStrictEqual((yield* attention(overview, config)).dismissedNeeds, []);
    }).pipe(
      Effect.provide(WebhookHealth.layer.pipe(Layer.provideMerge(changeBusLayer))),
      Effect.scoped,
    ),
);

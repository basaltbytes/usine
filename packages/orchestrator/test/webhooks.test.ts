import { OperatorLogin } from "@usine/core/operator";
import { assert, it } from "@effect/vitest";
import { Effect, Option, Ref } from "effect";
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
      const health = yield* WebhookHealth;
      const saved = yield* Ref.make<ReadonlyArray<AttentionAcknowledgement>>([]);
      const attention = webhookAttentionFor(health, { list: () => Ref.get(saved) });
      const overview = new ReadyOverview({ projects: [], loops: [], needsYou: [] });
      const config = {
        mode: "endpoint",
        publicUrl: new URL("https://usine.example/webhooks/github"),
      } as const;
      assert.isFalse(yield* health.silent);
      yield* TestClock.adjust("599 seconds");
      assert.deepStrictEqual((yield* attention(overview, config)).needsYou, []);
      yield* TestClock.adjust("1 second");
      assert.isTrue(yield* health.silent);
      assert.deepStrictEqual((yield* attention(overview, { mode: "off" })).needsYou, []);
      assert.deepStrictEqual((yield* attention(overview, { mode: "deliveries" })).needsYou, []);
      const warning = yield* attention(overview, config);
      assert.strictEqual(warning.needsYou.length, 1);
      assert.strictEqual(warning.needsYou[0]?._tag, "WebhookSilenceNeed");
      yield* Ref.set(
        saved,
        warning.needsYou.map(
          (need) =>
            new AttentionAcknowledgement({
              ...attentionKey(need),
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
      yield* TestClock.adjust("1 day");
      assert.isFalse(yield* health.silent);
      assert.deepStrictEqual((yield* attention(overview, config)).needsYou, []);
      assert.deepStrictEqual((yield* attention(overview, config)).dismissedNeeds, []);
    }).pipe(Effect.provide(WebhookHealth.layer)),
);

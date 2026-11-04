import { InstanceScope } from "@usine/core/access";
import { ChangeBus } from "@usine/core/changes";
import { Context, DateTime, Effect, FiberMap, Layer, Ref } from "effect";

/** Endpoint delivery health is independent of self-write hints and polling. */
export class WebhookHealth extends Context.Service<
  WebhookHealth,
  {
    readonly startedAt: DateTime.Utc;
    readonly reset: Effect.Effect<void>;
    readonly received: Effect.Effect<void>;
    readonly silent: Effect.Effect<boolean>;
  }
>()("@usine/orchestrator/webhooks/WebhookHealth") {
  static readonly layer = Layer.effect(
    WebhookHealth,
    Effect.gen(function* () {
      const bus = yield* ChangeBus;
      const changed = bus.publish([
        { audience: InstanceScope.make(), target: { kind: "attention", id: "instance" } },
      ]);
      let startedAt = yield* DateTime.now;
      const received = yield* Ref.make(false);
      const timers = yield* FiberMap.make<"silence">();
      const arm = FiberMap.run(
        timers,
        "silence",
        Effect.sleep("10 minutes").pipe(Effect.andThen(changed)),
      );
      yield* arm;
      return {
        get startedAt() {
          return startedAt;
        },
        reset: Effect.gen(function* () {
          startedAt = yield* DateTime.now;
          yield* Ref.set(received, false);
          yield* arm;
          yield* changed;
          yield* Effect.logInfo("Webhook delivery health reset after configuration change");
        }).pipe(Effect.withSpan("WebhookHealth.reset")),
        received: Effect.gen(function* () {
          if (!(yield* Ref.getAndSet(received, true))) {
            yield* FiberMap.remove(timers, "silence");
            yield* changed;
            yield* Effect.logInfo(
              "Received the first verified webhook delivery since endpoint activation",
            );
          }
        }).pipe(Effect.withSpan("WebhookHealth.received")),
        silent: Effect.gen(function* () {
          const now = yield* DateTime.now;
          return (
            !(yield* Ref.get(received)) &&
            DateTime.toEpochMillis(now) - DateTime.toEpochMillis(startedAt) >= 600_000
          );
        }),
      };
    }),
  );
}

import { Context, DateTime, Effect, Layer, Ref } from "effect";

/** Endpoint delivery health is independent of self-write hints and polling. */
export class WebhookHealth extends Context.Service<
  WebhookHealth,
  {
    readonly startedAt: DateTime.Utc;
    readonly reset: Effect.Effect<void>;
    readonly received: Effect.Effect<void>;
    readonly silent: Effect.Effect<boolean>;
  }
>()("@usine/orchestrator/WebhookHealth") {
  static readonly layer = Layer.effect(
    WebhookHealth,
    Effect.gen(function* () {
      let startedAt = yield* DateTime.now;
      const received = yield* Ref.make(false);
      return {
        get startedAt() {
          return startedAt;
        },
        reset: Effect.fn("WebhookHealth.reset")(function* () {
          startedAt = yield* DateTime.now;
          yield* Ref.set(received, false);
          yield* Effect.logInfo("Webhook delivery health reset after configuration change");
        })(),
        received: Effect.fn("WebhookHealth.received")(function* () {
          if (!(yield* Ref.getAndSet(received, true))) {
            yield* Effect.logInfo(
              "Received the first verified webhook delivery since endpoint activation",
            );
          }
        })(),
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

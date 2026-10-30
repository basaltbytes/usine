import type { LoadedInstance } from "@usine/config/instance";
import { CursorKey, CursorStore } from "@usine/engine/cursor";
import { GitHubApp, WebhookDeliveryId } from "@usine/github/github-app";
import { Clock, Context, DateTime, Duration, Effect, Layer, Option } from "effect";
import type { WatchedInstance } from "../reloads.ts";
import { PollingTriggers } from "./polling.ts";

const INTERVAL_MS = 10_000;

const make = Effect.gen(function* () {
  const app = yield* GitHubApp;
  const cursors = yield* CursorStore;
  const polling = yield* PollingTriggers;

  const poll = Effect.fn("WebhookDeliveries.poll")(function* (instance: LoadedInstance) {
    const installation = yield* app.installation();
    yield* Effect.annotateCurrentSpan({ installationId: installation.id });
    const key = CursorKey.make(`github-deliveries:${installation.id}`);
    const after = yield* cursors.read(key, WebhookDeliveryId);
    const deliveries = yield* app.deliveries(after);
    if (deliveries.length === 0) {
      yield* Effect.logDebug("No new webhook deliveries", { installationId: installation.id });
      return;
    }
    const relevant = deliveries.filter(
      (delivery) => delivery.event !== "ping" && Option.isSome(delivery.repositoryId),
    );
    const access =
      relevant.length === 0
        ? []
        : yield* app.projectAccess(instance.config.repos.map(({ name }) => name));
    const registered = new Map(
      access.flatMap((project) =>
        project._tag === "CoveredProject"
          ? [[project.repositoryId, project.repository] as const]
          : [],
      ),
    );
    const repositories = new Set(
      relevant.flatMap((delivery) =>
        Option.toArray(
          Option.flatMap(delivery.repositoryId, (id) => Option.fromUndefinedOr(registered.get(id))),
        ),
      ),
    );
    for (const repository of repositories) yield* polling.hint(repository);
    let newest = after;
    for (const delivery of deliveries) {
      if (Option.isNone(newest) || BigInt(delivery.id) > BigInt(newest.value)) {
        newest = Option.some(delivery.id);
      }
    }
    if (Option.isSome(newest)) yield* cursors.write(key, WebhookDeliveryId, newest.value);
    yield* Effect.logInfo("Webhook delivery hints processed", {
      installationId: installation.id,
      deliveries: deliveries.length,
      hintedRepositories: repositories.size,
      ignoredPingOrMissingRepository: deliveries.length - relevant.length,
      ignoredUnregistered: relevant.filter(
        (delivery) => !Option.exists(delivery.repositoryId, (id) => registered.has(id)),
      ).length,
    });
  });

  const run = (instances: WatchedInstance): Effect.Effect<never> =>
    Effect.gen(function* () {
      const startup = yield* instances.get;
      if (startup.config.webhooks.mode !== "deliveries") {
        yield* Effect.logInfo("Webhook delivery polling disabled", {
          mode: startup.config.webhooks.mode,
        });
        return yield* Effect.never;
      }
      yield* Effect.logInfo("Webhook delivery polling started", { intervalMs: INTERVAL_MS });
      return yield* Effect.gen(function* () {
        const instance = yield* instances.get;
        const delay = yield* poll(instance).pipe(
          Effect.timeout("30 seconds"),
          Effect.as(INTERVAL_MS),
          Effect.catch((error) =>
            Effect.gen(function* () {
              const sleepMs =
                error._tag === "GitHubRateLimitError"
                  ? Math.max(
                      INTERVAL_MS,
                      DateTime.toEpochMillis(error.retryAt) - (yield* Clock.currentTimeMillis),
                    )
                  : INTERVAL_MS;
              yield* Effect.logWarning("Webhook delivery polling failed; polling remains active", {
                errorTag: error._tag,
                message: error.message,
                sleepMs,
              });
              return sleepMs;
            }),
          ),
        );
        yield* Effect.sleep(Duration.millis(delay));
      }).pipe(Effect.forever);
    });

  return { poll, run };
});

export class WebhookDeliveries extends Context.Service<
  WebhookDeliveries,
  Effect.Success<typeof make>
>()("@usine/orchestrator/WebhookDeliveries") {
  static readonly layer = Layer.effect(WebhookDeliveries, make);
}

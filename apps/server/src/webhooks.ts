import { createHmac, timingSafeEqual } from "node:crypto";
import { RepositoryName, canonicalRepositoryName } from "@usine/core/repository";
import type { GitHubApp } from "@usine/github/github-app";
import type { LoadedInstance } from "@usine/config/instance";
import type { PollingTriggers } from "@usine/orchestrator/polling-triggers";
import type { WebhookHealth } from "@usine/orchestrator/webhooks";
import { ByteSize, Config, Effect, Layer, Option, Redacted, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

export class WebhookConfigurationError extends Schema.TaggedError<WebhookConfigurationError>(
  "@usine/server/WebhookConfigurationError",
)("WebhookConfigurationError", { message: Schema.String }) {}

class WebhookRequestError extends Schema.TaggedError<WebhookRequestError>(
  "@usine/server/WebhookRequestError",
)("WebhookRequestError", {
  status: Schema.Literals([400, 401]),
  message: Schema.String,
}) {}

const Payload = Schema.fromJsonString(
  Schema.Struct({
    repository: Schema.OptionFromOptionalKey(Schema.Struct({ full_name: RepositoryName })),
  }),
);
const Secret = Schema.Redacted(Schema.NonEmptyString);
const MAX_BODY_BYTES = 25 * 1024 * 1024;

export const webhookEndpoint: (
  instances: { readonly get: Effect.Effect<LoadedInstance> },
  polling: Pick<PollingTriggers["Service"], "hint">,
  health: WebhookHealth["Service"],
  app: Pick<GitHubApp["Service"], "configureWebhook">,
) => Effect.Effect<Layer.Layer<never, never, HttpRouter.HttpRouter>, WebhookConfigurationError> =
  Effect.fn("Server.webhookEndpoint")(function* (
    instances: { readonly get: Effect.Effect<LoadedInstance> },
    polling: Pick<PollingTriggers["Service"], "hint">,
    health: WebhookHealth["Service"],
    app: Pick<GitHubApp["Service"], "configureWebhook">,
  ) {
    const {
      config: { webhooks },
    } = yield* instances.get;
    yield* Effect.annotateCurrentSpan({ mode: webhooks.mode });
    if (webhooks.mode !== "endpoint") {
      yield* Effect.logInfo("Webhook endpoint disabled", { mode: webhooks.mode });
      return Layer.empty;
    }
    const secret = yield* Config.schema(Secret, "USINE_GITHUB_WEBHOOK_SECRET").pipe(
      Effect.mapError(
        () =>
          new WebhookConfigurationError({
            message:
              "Endpoint mode requires USINE_GITHUB_WEBHOOK_SECRET in the instance .env or environment. Set it to the GitHub App webhook secret and restart usine up.",
          }),
      ),
    );
    yield* app.configureWebhook(webhooks.publicUrl).pipe(
      Effect.timeout("30 seconds"),
      Effect.tapError((error) =>
        Effect.logWarning(
          "Could not configure the App webhook URL; normal polling remains active",
          {
            errorTag: error._tag,
            message: error.message,
          },
        ),
      ),
      Effect.ignore,
    );

    const receive = Effect.fn("Server.githubWebhook")(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const signature = request.headers["x-hub-signature-256"];
      if (signature === undefined || !/^sha256=[a-f0-9]{64}$/u.test(signature)) {
        return yield* new WebhookRequestError({
          status: 401,
          message: "Invalid webhook signature",
        });
      }
      const bytes = yield* request.arrayBuffer.pipe(
        Effect.provideService(
          HttpServerRequest.MaxBodySize,
          ByteSize.fromInputUnsafe(MAX_BODY_BYTES),
        ),
        Effect.timeout("10 seconds"),
        Effect.mapError(
          () =>
            new WebhookRequestError({
              status: 400,
              message: "Could not read webhook body within its size or time limit",
            }),
        ),
      );
      const body = Buffer.from(bytes);
      const expected = createHmac("sha256", Redacted.value(secret)).update(body).digest();
      if (!timingSafeEqual(expected, Buffer.from(signature.slice(7), "hex"))) {
        return yield* new WebhookRequestError({
          status: 401,
          message: "Invalid webhook signature",
        });
      }
      const event = yield* Schema.decodeUnknownEffect(Schema.NonEmptyString)(
        request.headers["x-github-event"],
      ).pipe(
        Effect.mapError(
          () => new WebhookRequestError({ status: 400, message: "Missing GitHub event header" }),
        ),
      );
      yield* Effect.annotateCurrentSpan({ event });
      const payload = yield* Schema.decodeUnknownEffect(Payload)(body.toString("utf8")).pipe(
        Effect.mapError(
          () => new WebhookRequestError({ status: 400, message: "Invalid webhook payload" }),
        ),
      );
      yield* health.received;
      if (event === "ping" || Option.isNone(payload.repository)) {
        yield* Effect.logInfo("Webhook delivery needs no repository refresh", { event });
        return HttpServerResponse.empty({ status: 204 });
      }
      const repository = payload.repository.value.full_name;
      yield* Effect.annotateCurrentSpan({ repository, event });
      const instance = yield* instances.get;
      const registered = instance.config.repos.find(
        ({ name }) => canonicalRepositoryName(name) === canonicalRepositoryName(repository),
      );
      if (registered === undefined) {
        yield* Effect.logInfo("Webhook delivery ignored for an unregistered repository", {
          repository,
          event,
        });
      } else {
        yield* polling.hint(registered.name);
        yield* Effect.logInfo("Webhook delivery queued a repository hint", {
          repository: registered.name,
          event,
        });
      }
      return HttpServerResponse.empty({ status: 204 });
    });

    return HttpRouter.add(
      "POST",
      "/webhooks/github",
      receive().pipe(
        Effect.catchTag("WebhookRequestError", (error) =>
          Effect.logWarning("Webhook delivery rejected", {
            status: error.status,
            reason: error.message,
          }).pipe(Effect.as(HttpServerResponse.text(error.message, { status: error.status }))),
        ),
        Effect.map(
          HttpServerResponse.setHeaders({
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
          }),
        ),
      ),
    );
  });

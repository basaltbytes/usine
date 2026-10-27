import { Effect, Layer, Redacted } from "effect";
import { HttpApiBuilder, HttpApiError } from "effect/http-api";
import { Attachment, type AttachmentId, newAttachmentId } from "../attachment/attachment.ts";
import { Attachments } from "../attachment/store.ts";
import { CallerClaims, CallerTokens } from "../caller/caller.ts";
import { GatewaySettings, SettingsInForce } from "../settings.ts";
import {
  AdminAuthorization,
  type AttachRequest,
  Attached,
  AttachmentList,
  AttachmentSummary,
  Detached,
  GatewayAdminApi,
  LlmProviderList,
} from "./api.ts";

const encoder = new TextEncoder();

const digest = (value: string) =>
  Effect.promise(() => crypto.subtle.digest("SHA-256", encoder.encode(value))).pipe(
    Effect.map((bytes) => new Uint8Array(bytes)),
  );

/** Returns whether two digests are equal, in constant time. */
const sameDigest = (left: Uint8Array, right: Uint8Array): boolean => {
  let difference = left.length ^ right.length;
  for (let index = 0; index < Math.min(left.length, right.length); index++)
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  return difference === 0;
};

const authorization = Layer.effect(
  AdminAuthorization,
  Effect.gen(function* () {
    const { adminToken } = yield* GatewaySettings;
    const expected = yield* digest(Redacted.value(adminToken));
    return {
      bearer: (httpEffect, { credential, endpoint }) =>
        Effect.gen(function* () {
          const presented = yield* digest(Redacted.value(credential));
          if (!sameDigest(expected, presented)) {
            yield* Effect.logWarning("Gateway refused an admin request", {
              reason: "bad-admin-token",
              endpoint: endpoint.identifier,
            });
            return yield* new HttpApiError.Unauthorized({});
          }
          return yield* httpEffect;
        }),
    };
  }),
);

/** Stores the attachment under `id` and returns its caller token. */
const store = Effect.fn("GatewayAdmin.store")(function* (id: AttachmentId, request: AttachRequest) {
  yield* Effect.annotateCurrentSpan({
    attachment: id,
    worker: request.worker,
    repository: request.repository,
  });
  const attachments = yield* Attachments;
  const callers = yield* CallerTokens;
  const attachment = new Attachment({ id, ...request });
  yield* attachments.attach(attachment);
  const callerToken = yield* callers.issue(
    new CallerClaims({ attachment: id, worker: request.worker, repository: request.repository }),
  );
  return new Attached({ attachment: AttachmentSummary.fromAttachment(attachment), callerToken });
});

const attachmentHandlers = HttpApiBuilder.group(GatewayAdminApi, "attachments", (routes) =>
  routes
    .handle("attach", ({ payload }) =>
      Effect.flatMap(newAttachmentId, (id) => store(id, payload)).pipe(
        // A new 128-bit ID can't belong to another attachment.
        Effect.catchTag("AttachmentConflict", Effect.die),
      ),
    )
    .handle("renew", ({ params, payload }) => store(params.id, payload))
    .handle(
      "detach",
      Effect.fn("GatewayAdmin.detach")(function* ({ params }) {
        yield* Effect.annotateCurrentSpan({ attachment: params.id });
        const attachments = yield* Attachments;
        return new Detached({ detached: yield* attachments.detach(params.id) });
      }),
    )
    .handle(
      "list",
      Effect.fn("GatewayAdmin.list")(function* () {
        const attachments = yield* Attachments;
        const current = yield* attachments.list();
        return new AttachmentList({ attachments: current.map(AttachmentSummary.fromAttachment) });
      }),
    ),
);

/** Handlers that return the current LLM providers, including changes from a reload. */
const llmHandlers = HttpApiBuilder.group(GatewayAdminApi, "llm", (routes) =>
  routes.handle(
    "providers",
    Effect.fn("GatewayAdmin.providers")(function* () {
      const { providers } = yield* (yield* SettingsInForce).current;
      const list = LlmProviderList.fromProviders(providers);
      yield* Effect.annotateCurrentSpan({
        providers: list.providers
          .map(({ provider, credential }) => `${provider}:${credential}`)
          .join(","),
      });
      return list;
    }),
  ),
);

/**
 * The admin API routes for an `HttpRouter`. Bind them to a loopback or private address; the
 * executor connects through SSH.
 */
export const adminRoutes = HttpApiBuilder.layer(GatewayAdminApi).pipe(
  Layer.provide([attachmentHandlers, llmHandlers]),
  Layer.provide(authorization),
);

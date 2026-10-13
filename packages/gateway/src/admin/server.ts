import { Effect, Layer, Redacted } from "effect";
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi";
import type { Attachment } from "../attachment/attachment.ts";
import { Attachments } from "../attachment/store.ts";
import { CallerClaims, CallerTokens } from "../caller/caller.ts";
import { GatewaySettings } from "../settings.ts";
import {
  AdminAuthorization,
  Attached,
  AttachmentList,
  AttachmentSummary,
  Detached,
  GatewayAdminApi,
} from "./api.ts";

const encoder = new TextEncoder();

const digest = (value: string) =>
  Effect.promise(() => crypto.subtle.digest("SHA-256", encoder.encode(value))).pipe(
    Effect.map((bytes) => new Uint8Array(bytes)),
  );

/** Compares two digests in time that does not depend on where they differ. */
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
              endpoint: endpoint.name,
            });
            return yield* new HttpApiError.Unauthorized({});
          }
          return yield* httpEffect;
        }),
    };
  }),
);

const handlers = HttpApiBuilder.group(GatewayAdminApi, "attachments", (routes) =>
  routes
    .handle(
      "attach",
      Effect.fn("GatewayAdmin.attach")(function* ({ payload }: { readonly payload: Attachment }) {
        yield* Effect.annotateCurrentSpan({
          worker: payload.worker,
          repository: payload.repository,
        });
        const attachments = yield* Attachments;
        const callers = yield* CallerTokens;
        yield* attachments.attach(payload);
        const callerToken = yield* callers.issue(
          new CallerClaims({ worker: payload.worker, repository: payload.repository }),
        );
        return new Attached({ attachment: AttachmentSummary.fromAttachment(payload), callerToken });
      }),
    )
    .handle(
      "detach",
      Effect.fn("GatewayAdmin.detach")(function* ({ query }) {
        yield* Effect.annotateCurrentSpan({ worker: query.worker, repository: query.repository });
        const attachments = yield* Attachments;
        return new Detached({
          detached: yield* attachments.detach(query.worker, query.repository),
        });
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

/**
 * The admin API's routes, for an `HttpRouter` the platform serves. Bind it
 * to a loopback or otherwise private address: the executor reaches it
 * through its SSH connection to the gateway.
 */
export const adminRoutes = HttpApiBuilder.layer(GatewayAdminApi).pipe(
  Layer.provide(handlers),
  Layer.provide(authorization),
);

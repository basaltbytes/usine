import {
  LoginProvider,
  ProviderLoginView,
  ProviderStatus,
  type ProviderTarget,
} from "@usine/gateway/credentials";
import type { ProviderSelectors } from "@usine/core/agent/provider";
import { Option, Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { AuthenticationError } from "../auth/api.ts";
import { AuthError } from "../auth/model.ts";

const ok = Schema.Struct({ ok: Schema.Boolean });
const secret = Schema.Redacted(
  Schema.NonEmptyString.check(Schema.isMaxLength(4096), Schema.isPattern(/^[^\r\n]+$/u)),
);
/** A provider of the destination, named by its slot or ID, or by the subscription login it accepts. */
const named = { target: Schema.NonEmptyString, provider: Schema.NonEmptyString };
export const BeginRequest = Schema.Struct({
  target: Schema.NonEmptyString,
  provider: LoginProvider,
});
export const CodeRequest = Schema.Struct({ id: Schema.String, code: secret });
export const KeyRequest = Schema.Struct({ ...named, key: secret });
export const DisconnectRequest = Schema.Struct(named);

/** Returns the names that select `listed`, a provider of a destination, for `selectProvider`. */
export const listedSelectors = ({
  provider,
  id,
  accepts,
}: Pick<
  ProviderTarget["providers"][number],
  "provider" | "id" | "accepts"
>): ProviderSelectors => ({
  slot: provider,
  id,
  login: Option.fromNullOr(accepts.login),
});
const error = AuthError.fields.status.literals.map((status) =>
  AuthenticationError.annotate({
    httpApiStatus: status,
    description: "Provider connection request failed.",
  }),
);
export const ProviderApi = HttpApiGroup.make("providers").add(
  HttpApiEndpoint.get("status", "/api/providers", {
    success: ProviderStatus,
    error,
  })
    .annotate(OpenApi.Summary, "Read provider connections")
    .annotate(
      OpenApi.Description,
      "Returns the providers of configured gateways or local harnesses, each with its ID, display name, the credentials it accepts, and credential metadata, and pending authorization prompts. Requires instance admin or setup access.",
    ),
  HttpApiEndpoint.post("begin", "/api/providers/login", {
    payload: BeginRequest,
    success: ProviderLoginView,
    error,
  })
    .annotate(OpenApi.Summary, "Start provider sign-in")
    .annotate(
      OpenApi.Description,
      "Starts an isolated native provider login. Poll connection status for its authorization page and device code.",
    ),
  HttpApiEndpoint.post("code", "/api/providers/code", {
    payload: CodeRequest,
    success: ok,
    error,
  })
    .annotate(OpenApi.Summary, "Submit a Claude authorization code")
    .annotate(
      OpenApi.Description,
      "Passes the code to the pending Claude login. Completed credentials transfer to the configured destination.",
    ),
  HttpApiEndpoint.delete("cancel", "/api/providers/login/:id", {
    params: { id: Schema.String },
    success: ok,
    error,
  })
    .annotate(OpenApi.Summary, "Cancel provider sign-in")
    .annotate(
      OpenApi.Description,
      "Stops an unfinished login and preserves the previously saved credential.",
    ),
  HttpApiEndpoint.put("key", "/api/providers/key", {
    payload: KeyRequest,
    success: ok,
    error,
  })
    .annotate(OpenApi.Summary, "Connect a provider API key")
    .annotate(
      OpenApi.Description,
      "Saves an API key on the selected destination and updates gateway worker routing. `provider` names a provider that the destination lists, by its slot or ID, or by the subscription login it accepts.",
    ),
  HttpApiEndpoint.post("disconnect", "/api/providers/disconnect", {
    payload: DisconnectRequest,
    success: ok,
    error,
  })
    .annotate(OpenApi.Summary, "Disconnect a provider")
    .annotate(
      OpenApi.Description,
      "Removes the saved credential and gateway worker routing, cancelling any unfinished login for this destination and provider.",
    ),
);

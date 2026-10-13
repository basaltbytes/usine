import { Context, Schema } from "effect";
import type { EgressAllowlist } from "./egress/egress.ts";
import type { GitHubOrigins } from "./github/github.ts";
import type { LlmProviders } from "./llm/llm.ts";

/**
 * The private DNS domain the gateway answers for. Workers reach GitHub at
 * `git.<domain>` and the LLM providers at `llm.<domain>`.
 */
export const GatewayDomain = Schema.String.check(
  Schema.isPattern(
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u,
    {
      message: "Expected a lowercase DNS domain",
    },
  ),
).pipe(Schema.brand("GatewayDomain"));
export type GatewayDomain = typeof GatewayDomain.Type;

/** The HMAC key caller tokens are signed with, decoded from its raw value: at least 32 characters, held only by the gateway. */
export const CallerKey = Schema.RedactedFromValue(
  Schema.String.check(
    Schema.isMinLength(32, { message: "Expected a caller key of at least 32 characters" }),
  ),
);
export type CallerKey = typeof CallerKey.Type;

/** The bearer token the executor sends to the admin API, decoded from its raw value: at least 32 characters. */
export const AdminToken = Schema.RedactedFromValue(
  Schema.String.check(
    Schema.isMinLength(32, { message: "Expected an admin token of at least 32 characters" }),
  ),
);
export type AdminToken = typeof AdminToken.Type;

/**
 * The gateway's configuration, read once at startup by the platform entry
 * point. Secrets stay `Redacted` and are only unwrapped where they are sent
 * or used to sign.
 */
export class GatewaySettings extends Context.Service<
  GatewaySettings,
  {
    readonly domain: GatewayDomain;
    readonly github: GitHubOrigins;
    readonly providers: LlmProviders;
    readonly egress: EgressAllowlist;
    readonly adminToken: AdminToken;
    readonly callerKey: CallerKey;
  }
>()("@usine/gateway/GatewaySettings") {}

/** The host names the gateway serves under its domain. */
export const gatewayHosts = (domain: GatewayDomain) =>
  ({ git: `git.${domain}`, llm: `llm.${domain}` }) as const;

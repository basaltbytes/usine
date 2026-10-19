import type { GatewayDomain } from "@usine/core/worker";
import { Context, Effect, Layer, Ref, Schema } from "effect";
import type { EgressAllowlist } from "./egress/egress.ts";
import type { GitHubOrigins } from "./github/github.ts";
import type { LlmProviders } from "./llm/llm.ts";

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
 * The gateway's configuration as the platform entry point read it at
 * startup. Secrets stay `Redacted` and are only unwrapped where they are sent
 * or used to sign. A reload replaces the egress allowlist and the LLM
 * providers in `SettingsInForce`, and requests read them there; `egress` and
 * `providers` here keep their startup values, and the other settings change
 * only with a restart.
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

/** The settings a reload replaces without a restart: the egress allowlist and the LLM providers. */
export interface ReloadableSettings {
  readonly egress: EgressAllowlist;
  readonly providers: LlmProviders;
}

/**
 * The egress allowlist and LLM providers in force. They start as the ones in
 * `GatewaySettings`, and a reload replaces them. A request reads them once,
 * when it is decided, so a tunnel the previous allowlist opened stays open.
 */
export class SettingsInForce extends Context.Service<
  SettingsInForce,
  {
    /** The allowlist and providers requests are decided with now. */
    readonly current: Effect.Effect<ReloadableSettings>;
    /** Replaces them for every request decided afterwards. */
    readonly replace: (next: ReloadableSettings) => Effect.Effect<void>;
  }
>()("@usine/gateway/SettingsInForce") {
  static readonly layer = Layer.effect(
    SettingsInForce,
    Effect.gen(function* () {
      const { egress, providers } = yield* GatewaySettings;
      const inForce = yield* Ref.make<ReloadableSettings>({ egress, providers });
      return { current: Ref.get(inForce), replace: (next) => Ref.set(inForce, next) };
    }),
  );
}

/** The host names the gateway serves under its domain. */
export const gatewayHosts = (domain: GatewayDomain) =>
  ({ git: `git.${domain}`, llm: `llm.${domain}` }) as const;

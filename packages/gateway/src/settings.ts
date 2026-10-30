import type { GatewayDomain } from "@usine/core/worker";
import { Context, Effect, Layer, Ref, Schema } from "effect";
import type { EgressAllowlist } from "./egress/egress.ts";
import type { GitHubOrigins } from "./github/github.ts";
import type { LlmProviders } from "./llm/llm.ts";

/** The HMAC key that signs caller tokens, at least 32 characters, known only to the gateway. */
export const CallerKey = Schema.RedactedFromValue(
  Schema.String.check(
    Schema.isMinLength(32, { message: "Expected a caller key of at least 32 characters" }),
  ),
);
export type CallerKey = typeof CallerKey.Type;

/** The bearer token the executor sends to the admin API, at least 32 characters. */
export const AdminToken = Schema.RedactedFromValue(
  Schema.String.check(
    Schema.isMinLength(32, { message: "Expected an admin token of at least 32 characters" }),
  ),
);
export type AdminToken = typeof AdminToken.Type;

/**
 * The gateway's configuration as read at startup. Secrets stay `Redacted` until sent or used to
 * sign. `egress` and `providers` keep their startup values; reloaded values are in
 * `SettingsInForce`. Other settings change only with a restart.
 */
export class GatewaySettings extends Context.Service<
  GatewaySettings,
  {
    /** The private DNS domain under which the gateway serves `git` and `llm` hosts. */
    readonly domain: GatewayDomain;
    /** The GitHub upstream origins fixed for this process. */
    readonly github: GitHubOrigins;
    /** The startup LLM providers; requests use the current providers from `SettingsInForce`. */
    readonly providers: LlmProviders;
    /** The startup egress allowlist; requests use the current allowlist from `SettingsInForce`. */
    readonly egress: EgressAllowlist;
    /** The bearer token required for the executor to call the admin API. */
    readonly adminToken: AdminToken;
    /** The secret used to sign caller tokens; changing it invalidates existing signatures. */
    readonly callerKey: CallerKey;
  }
>()("@usine/gateway/GatewaySettings") {}

/** The settings a reload replaces: the egress allowlist and LLM providers. */
export interface ReloadableSettings {
  /** The allowlist to use for new forward-proxy requests and tunnels. */
  readonly egress: EgressAllowlist;
  /** The LLM upstreams and credentials to use for subsequent reverse-proxy requests. */
  readonly providers: LlmProviders;
}

/**
 * The current egress allowlist and LLM providers, initially from `GatewaySettings` and
 * replaced by each reload. A request reads them once, so a tunnel opened under the previous
 * allowlist stays open.
 */
export class SettingsInForce extends Context.Service<
  SettingsInForce,
  {
    /** Returns the current allowlist and providers. */
    readonly current: Effect.Effect<ReloadableSettings>;
    /** Replaces them for all later requests. */
    readonly replace: (next: ReloadableSettings) => Effect.Effect<void>;
  }
>()("@usine/gateway/SettingsInForce") {
  /**
   * Initializes shared reloadable settings from `GatewaySettings`; does not read files or watch
   * for changes.
   */
  static readonly layer = Layer.effect(
    SettingsInForce,
    Effect.gen(function* () {
      const { egress, providers } = yield* GatewaySettings;
      const inForce = yield* Ref.make<ReloadableSettings>({ egress, providers });
      return { current: Ref.get(inForce), replace: (next) => Ref.set(inForce, next) };
    }),
  );
}

/** Returns the host names the gateway serves under `domain`. */
export const gatewayHosts = (domain: GatewayDomain) =>
  ({ git: `git.${domain}`, llm: `llm.${domain}` }) as const;

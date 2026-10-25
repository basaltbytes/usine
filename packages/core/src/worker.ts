import { Schema } from "effect";

export const WorkerName = Schema.String.check(
  Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u, {
    message: "Expected a kebab-case worker name",
  }),
).pipe(Schema.brand("WorkerName"));

export type WorkerName = typeof WorkerName.Type;

export const WORKER_KINDS = ["local", "exe.dev", "ssh"] as const;
export const WorkerKind = Schema.Literals(WORKER_KINDS);
export type WorkerKind = typeof WorkerKind.Type;

/**
 * The GitHub bot login that an Attempt writes as: the factory's GitHub App on local and SSH
 * Workers, or the exe.dev GitHub integration on exe.dev Workers (ADR 0011).
 */
export const BotLogin = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\[bot\]$/u, {
    message: "Expected a GitHub bot login: <slug>[bot]",
  }),
).pipe(Schema.brand("BotLogin"));
export type BotLogin = typeof BotLogin.Type;

/** The user ID of a GitHub App's bot account. It differs from the App ID. */
export const BotUserId = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).pipe(
  Schema.brand("BotUserId"),
);
export type BotUserId = typeof BotUserId.Type;

/**
 * A GitHub App's bot account. The factory App's account authors and commits every Attempt's
 * commits on every Worker kind (ADR 0011).
 */
export class BotAccount extends Schema.Class<BotAccount>("BotAccount")({
  login: BotLogin,
  id: BotUserId,
}) {
  /** The ID-based noreply address, which GitHub links to the account even after a rename. */
  get noreplyEmail(): string {
    return `${String(this.id)}+${this.login}@users.noreply.github.com`;
  }
}

/**
 * The `ssh` destination: a host name, address, or SSH config Host alias, optionally prefixed
 * with `user@`. Rejects values that `ssh` could parse as an option, such as `-oProxyCommand=...`.
 */
export const SshDestination = Schema.String.check(
  Schema.isPattern(/^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/u, {
    message: "Expected an SSH destination: a host name or address, optionally prefixed by a user",
  }),
).pipe(Schema.brand("SshDestination"));
export type SshDestination = typeof SshDestination.Type;

export const SshPort = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_535 })).pipe(
  Schema.brand("SshPort"),
);
export type SshPort = typeof SshPort.Type;

/** The `ssh` private key path, absolute or starting with `~/`. */
export const SshIdentityFile = Schema.String.check(
  Schema.isPattern(/^(?:\/|~\/)[!-~]+$/u, {
    message: "Expected an absolute or ~/ key path without spaces or control characters",
  }),
).pipe(Schema.brand("SshIdentityFile"));
export type SshIdentityFile = typeof SshIdentityFile.Type;

/**
 * The absolute directory on the Worker's machine that contains `workers/<worker>`, with cached
 * clones, Attempt checkouts, and Attempt credentials.
 */
export const WorkerRoot = Schema.String.check(
  Schema.isPattern(/^(?:\/[!-.0-~]+)+$/u, {
    message: "Expected an absolute directory without spaces, control characters, or a trailing /",
  }),
).pipe(Schema.brand("WorkerRoot"));
export type WorkerRoot = typeof WorkerRoot.Type;

/**
 * The Gateway's private DNS domain, which serves `git.<domain>` for GitHub, `llm.<domain>` for
 * LLM providers, and `<domain>` for the forward proxy
 * ([ADR 0027](../../../docs/adr/0027-gateway-credential-proxy.md)).
 */
export const GatewayDomain = Schema.String.check(
  Schema.isPattern(
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u,
    { message: "Expected a lowercase DNS domain" },
  ),
).pipe(Schema.brand("GatewayDomain"));
export type GatewayDomain = typeof GatewayDomain.Type;

/** The Gateway admin API port on the Gateway's loopback interface (`USINE_GATEWAY_ADMIN_PORT`), used through an SSH forward. */
export const GatewayAdminPort = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: 65_535 }),
).pipe(Schema.brand("GatewayAdminPort"));
export type GatewayAdminPort = typeof GatewayAdminPort.Type;

/**
 * An LLM provider whose credential the Gateway stores. The harness for that provider, Claude
 * Code for `anthropic` and Codex for `openai`, uses the Attempt's caller token instead of a login
 * on the machine.
 */
export const GatewayLlmProvider = Schema.Literals(["anthropic", "openai"]);
export type GatewayLlmProvider = typeof GatewayLlmProvider.Type;

/**
 * The kind of LLM provider credential that the Gateway stores, as reported by its admin API.
 * `api-key` is billed at API rates; `subscription` uses a plan: a Claude plan from
 * `claude setup-token`, or a ChatGPT plan from `codex login`
 * ([ADR 0013](../../../docs/adr/0013-cost-accounting-native-meters-guardrails.md)).
 */
export const GatewayCredentialKind = Schema.Literals(["api-key", "subscription"]);
export type GatewayCredentialKind = typeof GatewayCredentialKind.Type;

/**
 * A container image reference, `[registry/]repository[:tag][@digest]`, such as
 * `ghcr.io/basaltbytes/usine-worker:claude-2.1.308-codex-0.159.2`. Rejects values that the
 * container CLI could parse as an option.
 */
export const ContainerImage = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][A-Za-z0-9._/:@-]{0,254}$/u, {
    message:
      "Expected a container image reference, such as ghcr.io/owner/image:tag, without spaces or a leading dash",
  }),
).pipe(Schema.brand("ContainerImage"));
export type ContainerImage = typeof ContainerImage.Type;

/** The CPUs a container may use, such as `1.5`. */
export const ContainerCpus = Schema.Finite.check(Schema.isGreaterThan(0)).pipe(
  Schema.brand("ContainerCpus"),
);
export type ContainerCpus = typeof ContainerCpus.Type;

/** A container's memory limit in MiB. */
export const ContainerMemoryMib = Schema.Int.check(Schema.isGreaterThanOrEqualTo(256)).pipe(
  Schema.brand("ContainerMemoryMib"),
);
export type ContainerMemoryMib = typeof ContainerMemoryMib.Type;

/** The maximum number of processes and threads in a container. */
export const ContainerPids = Schema.Int.check(Schema.isGreaterThanOrEqualTo(64)).pipe(
  Schema.brand("ContainerPids"),
);
export type ContainerPids = typeof ContainerPids.Type;

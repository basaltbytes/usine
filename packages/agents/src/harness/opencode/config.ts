import type { BrainSpec } from "@usine/core/agent/brain";
import type { AgentSessionId } from "@usine/core/agent/session";
import { Effect, Option, Schema } from "effect";
import type { CredentialRoute } from "../capability.ts";
import type { NativeTools } from "../role.ts";
import { OPENCODE_BASE_URL, OPENCODE_HOME, opencode } from "./descriptor.ts";

/** The OpenCode provider that usine configures with the session's credential. */
export const PROVIDER = "openai";

/** A rule of OpenCode's permission list; the last rule that matches a tool call applies. */
interface Permission {
  readonly action: string;
  readonly resource: string;
  readonly effect: "allow" | "deny";
}

const rule = (action: string, effect: Permission["effect"], resource = "*"): Permission => ({
  action,
  resource,
  effect,
});

/**
 * The base permissions of every session. Nothing asks, because a question waits for an answer
 * that never comes: `.env` reads, which ask by default, are allowed, and the `question` tool is
 * denied. Web fetch and search are denied, so OpenCode's server contacts no host but the model's.
 */
const BASE_PERMISSIONS: ReadonlyArray<Permission> = [
  rule("*", "allow"),
  rule("read", "allow", "*.env"),
  rule("read", "allow", "*.env.*"),
  rule("question", "deny"),
  rule("webfetch", "deny"),
  rule("websearch", "deny"),
];

/** The tools that read and search files, which a `read` role keeps. */
const READ_TOOLS = ["read", "glob", "grep"];

/**
 * Returns the session permissions for a role that keeps `nativeTools` of OpenCode's own tools. A
 * tool whose last matching rule denies every resource leaves the model's list, and denying `*`
 * also denies reads outside the session's directory.
 */
export const sessionPermissions = (nativeTools: NativeTools): ReadonlyArray<Permission> =>
  nativeTools === "all"
    ? BASE_PERMISSIONS
    : [
        rule("*", "deny"),
        ...(nativeTools === "read" ? READ_TOOLS.map((tool) => rule(tool, "allow")) : []),
      ];

/** Returns the OpenCode reasoning variant for `effort`. */
export const effortVariant = (effort: BrainSpec["effort"]): string =>
  effort === "off" ? "none" : effort;

const encodeConfig = Schema.encodeEffect(Schema.fromJsonString(Schema.Json));

/**
 * Returns the variable that holds the model credential on `route`, from the descriptor's
 * credential wiring.
 */
const tokenVariable = (route: CredentialRoute): string =>
  Option.match(opencode.worker.credential, {
    onNone: () => "OPENAI_API_KEY",
    onSome: (credential) =>
      route === "api-key" ? credential.apiKey.tokenVariable : credential.gateway.tokenVariable,
  });

/**
 * Returns the configuration of a session's `opencode serve`, as `OPENCODE_CONFIG_CONTENT`. It pins
 * the model, points the OpenAI provider at the route's base URL with the route's key, refuses every
 * other provider, plugin, MCP server, and web search, and turns off the requests that OpenCode
 * makes for itself: title generation, prompt-cache warming, and the local model servers it looks
 * for. The checkout's root `AGENTS.md` is its only instruction file.
 */
export const serveConfig = Effect.fn("OpenCodeConfig.serve")(function* (options: {
  readonly brain: BrainSpec;
  readonly route: CredentialRoute;
  readonly cwd: string;
  readonly baseUrl: Option.Option<string>;
}) {
  return yield* encodeConfig({
    model: `${PROVIDER}/${options.brain.model}`,
    providers: {
      [PROVIDER]: {
        // Without its own variables, a stray OPENAI_API_KEY on the worker can't replace the key.
        env: [],
        settings: {
          apiKey: `{env:${tokenVariable(options.route)}}`,
          transport: "http",
          ...Option.match(options.baseUrl, {
            onNone: () => ({}),
            onSome: () => ({ baseURL: `{env:${OPENCODE_BASE_URL}}` }),
          }),
        },
      },
      lmstudio: { settings: { baseURL: "" } },
      ollama: { settings: { baseURL: "" } },
      vllm: { settings: { baseURL: "" } },
    },
    policies: [
      { action: "provider.use", resource: "*", effect: "deny" },
      { action: "provider.use", resource: PROVIDER, effect: "allow" },
      { action: "plugin.use", resource: "*", effect: "deny" },
      { action: "mcp.use", resource: "*", effect: "deny" },
      { action: "websearch.use", resource: "*", effect: "deny" },
    ],
    permissions: BASE_PERMISSIONS.map((permission) => ({ ...permission })),
    websearch: false,
    formatter: false,
    warming: false,
    agents: { title: { disabled: true } },
    instructions: [`${options.cwd}/AGENTS.md`],
  }).pipe(Effect.orDie);
});

/**
 * Returns the data directory of session `sessionId`: a directory per session in the attempt's
 * OpenCode home, or, without one, next to the checkout. A separate database per session keeps two
 * sessions from racing on its migrations and keeps saved credentials out.
 */
export const dataDirectory = (
  environment: Readonly<Record<string, string>>,
  cwd: string,
  sessionId: AgentSessionId,
): string => {
  const session = sessionId.replaceAll(/[^A-Za-z0-9_-]/gu, "_");
  const home = environment[OPENCODE_HOME];
  return home === undefined || home === "" ? `${cwd}.opencode/${session}` : `${home}/${session}`;
};

/**
 * The prefix of the variables that the bridge sets on `serve` only, without the prefix. It equals
 * `SERVE_ONLY_PREFIX` in `bridge/main.ts`.
 */
const SERVE_ONLY_PREFIX = "USINE_OPENCODE_SERVE_";

/**
 * Returns the environment of a session's bridge: the session's environment, and for `serve` only
 * OpenCode's data, database, and configuration in `data`, the checkout's own configuration turned off, no
 * catalog download, no free models, and `config` as its configuration. Tool commands get the
 * session's environment, which keeps the worker's data and configuration directories, once the
 * runtime sets each OpenCode session's command environment from the bridge.
 */
export const serveEnvironment = (
  environment: Readonly<Record<string, string>>,
  data: string,
  config: string,
) => ({
  ...environment,
  ...Object.fromEntries(
    Object.entries({
      XDG_DATA_HOME: data,
      // OpenCode's default path under `XDG_DATA_HOME`, which a worker's `OPENCODE_DB` would move.
      OPENCODE_DB: `${data}/opencode/opencode.db`,
      XDG_CONFIG_HOME: `${data}/config`,
      OPENCODE_CONFIG_PROJECT_DISABLE: "1",
      OPENCODE_DISABLE_CLAUDE_CODE: "1",
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      OPENCODE_DISABLE_FREE_MODELS: "1",
      OPENCODE_CONFIG_CONTENT: config,
    }).map(([name, value]) => [`${SERVE_ONLY_PREFIX}${name}`, value]),
  ),
});

/** The base URL that the session's environment sets for the route, if any. */
export const baseUrl = (environment: Readonly<Record<string, string>>): Option.Option<string> =>
  Option.fromNullishOr(environment[OPENCODE_BASE_URL]).pipe(Option.filter((url) => url.length > 0));

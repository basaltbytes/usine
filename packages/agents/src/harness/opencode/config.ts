import type { BrainSpec } from "@usine/core/agent/brain";
import type { AgentSessionId } from "@usine/core/agent/session";
import { Effect, Option, Record, Schema } from "effect";
import { UnknownModelError } from "../../runtime.ts";
import type { AdmissionContext } from "../admission.ts";
import { type CredentialRoute, isGatewayRoute } from "../capability.ts";
import type { ModelChoice } from "../harness.ts";
import type { NativeTools } from "../role.ts";
import { OPENCODE_BASE_URL, OPENCODE_HOME, opencode } from "./descriptor.ts";

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
 * The client MCP server that serves a session's usine tools. OpenCode names each of its tools
 * `usine_<tool>`.
 */
export const TOOL_SERVER = "usine";

/**
 * Returns the session permissions for a role that keeps `nativeTools` of OpenCode's own tools,
 * with `usineTools` served or not. A tool whose last matching rule denies every resource leaves
 * the model's list, and denying `*` also denies reads outside the session's directory. Usine tools
 * need `execute` denied: while the model can call it, OpenCode's Code Mode lists MCP tools only in
 * `execute`'s catalog.
 */
export const sessionPermissions = (
  nativeTools: NativeTools,
  usineTools: "served" | "none",
): ReadonlyArray<Permission> => {
  const served = usineTools === "served";
  const tools = served ? [rule(`${TOOL_SERVER}_*`, "allow")] : [];
  if (nativeTools === "all")
    return served ? [...BASE_PERMISSIONS, rule("execute", "deny")] : BASE_PERMISSIONS;
  return [
    rule("*", "deny"),
    ...(nativeTools === "read" ? READ_TOOLS.map((tool) => rule(tool, "allow")) : []),
    ...tools,
  ];
};

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
 * The credential of an OpenCode session: the route whose key it reads, and the variable that holds
 * the base URL of the model's provider, if the session's environment sets one.
 */
interface SessionCredential {
  readonly route: CredentialRoute;
  readonly baseUrl: Option.Option<string>;
}

/**
 * Returns the credential of a session from its `environment` and its `context`'s route.
 *
 * - On a gateway route, the session uses the caller token and the variable of the slot of the
 *   model's provider, which the gateway sets for each slot that it holds.
 * - On a gateway route whose environment has no slot of the model's provider but sets
 *   `OPENCODE_BASE_URL`, the session uses the attempt's API key: a worker reports the attempt's
 *   provisioned key as the gateway's `api-key` kind.
 * - On any other route, the session uses the API key, and `OPENCODE_BASE_URL` if it is set.
 *
 * Fails for a provider that the route can't reach, which admission refuses first, and on a gateway
 * route for a provider whose slot the gateway doesn't hold.
 */
export const sessionCredential = Effect.fn("OpenCodeConfig.sessionCredential")(function* (
  environment: Readonly<Record<string, string>>,
  brain: BrainSpec,
  choice: ModelChoice,
  context: AdmissionContext,
) {
  const { placement, credential: admitted } = context;
  const isSet = (variable: string) => (environment[variable] ?? "") !== "";
  const slot = Option.filter(
    Option.flatMap(opencode.worker.credential, ({ slots }) =>
      Record.get(slots, choice.provider.id),
    ),
    () => isGatewayRoute(admitted),
  ).pipe(
    Option.map(({ variable }) => variable),
    Option.filter(isSet),
  );
  if (Option.isSome(slot)) return { route: admitted, baseUrl: slot } satisfies SessionCredential;
  const route: CredentialRoute =
    isGatewayRoute(admitted) && isSet(OPENCODE_BASE_URL) ? "api-key" : admitted;
  const fields = { model: brain.model, provider: choice.provider.id, admitted, route };
  if (route !== admitted)
    yield* Effect.logInfo(
      "OpenCode uses the attempt's API key: the gateway holds no slot of the model's provider",
      fields,
    );
  if (!opencode.reaches(choice.provider, placement, route)) {
    yield* Effect.logError("OpenCode reaches the model's provider only through a gateway", fields);
    return yield* UnknownModelError.make({
      harness: opencode.id,
      model: brain.model,
      message: `OpenCode reaches ${choice.provider.label} models only through a gateway that holds its key, and the ${route} route has none`,
    });
  }
  if (!isGatewayRoute(route))
    return {
      route,
      baseUrl: Option.some(OPENCODE_BASE_URL).pipe(Option.filter(isSet)),
    } satisfies SessionCredential;
  yield* Effect.logError("The gateway holds no slot of the model's provider", fields);
  return yield* UnknownModelError.make({
    harness: opencode.id,
    model: brain.model,
    message: `The gateway holds no ${choice.provider.label} credential for the model "${brain.model}". Connect one for ${choice.provider.id} at the gateway, and list its slot ${choice.provider.slot} in the worker's llm_providers.`,
  });
});

/**
 * Returns the configuration of a session's `opencode serve`, as `OPENCODE_CONFIG_CONTENT`. It pins
 * the model, points the model's provider at the base URL in `baseUrl`, a variable, with the
 * route's key, refuses every other provider, plugin, MCP server, and web search, and turns off the
 * requests that OpenCode makes for itself: title generation, prompt-cache warming, and the local
 * model servers it looks for. The checkout's root `AGENTS.md` is its only instruction file.
 */
export const serveConfig = Effect.fn("OpenCodeConfig.serve")(function* (options: {
  readonly choice: ModelChoice;
  readonly route: CredentialRoute;
  readonly cwd: string;
  readonly baseUrl: Option.Option<string>;
}) {
  const provider = options.choice.provider.id;
  return yield* encodeConfig({
    model: `${provider}/${options.choice.model}`,
    providers: {
      [provider]: {
        // Without its own variables, a stray key variable on the worker can't replace the key.
        env: [],
        settings: {
          apiKey: `{env:${tokenVariable(options.route)}}`,
          transport: "http",
          ...Option.match(options.baseUrl, {
            onNone: () => ({}),
            onSome: (variable) => ({ baseURL: `{env:${variable}}` }),
          }),
        },
      },
      lmstudio: { settings: { baseURL: "" } },
      ollama: { settings: { baseURL: "" } },
      vllm: { settings: { baseURL: "" } },
    },
    policies: [
      { action: "provider.use", resource: "*", effect: "deny" },
      { action: "provider.use", resource: provider, effect: "allow" },
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
 * Returns OpenCode's XDG base directories in `root`: its data in `root`, and its configuration,
 * state, and cache in subdirectories. OpenCode creates folders in each of them on every start,
 * `--version` included, so a home directory that it can't write to doesn't stop it.
 */
export const openCodeDirectories = (root: string) => ({
  XDG_DATA_HOME: root,
  XDG_CONFIG_HOME: `${root}/config`,
  XDG_STATE_HOME: `${root}/state`,
  XDG_CACHE_HOME: `${root}/cache`,
});

/**
 * The prefix of the variables that the bridge sets on `serve` only, without the prefix. It equals
 * `SERVE_ONLY_PREFIX` in `bridge/main.ts`.
 */
const SERVE_ONLY_PREFIX = "USINE_OPENCODE_SERVE_";

/**
 * Returns the environment of a session's bridge: the session's environment, and for `serve` only
 * OpenCode's directories and database in `data`, the checkout's own configuration turned off, no
 * catalog download, no free models, and `config` as its configuration. Tool commands get the
 * session's environment, which keeps the worker's XDG directories, once the runtime sets each
 * OpenCode session's command environment from the bridge.
 */
export const serveEnvironment = (
  environment: Readonly<Record<string, string>>,
  data: string,
  config: string,
) => ({
  ...environment,
  ...Object.fromEntries(
    Object.entries({
      ...openCodeDirectories(data),
      // OpenCode's default path under `XDG_DATA_HOME`, which a worker's `OPENCODE_DB` would move.
      OPENCODE_DB: `${data}/opencode/opencode.db`,
      OPENCODE_CONFIG_PROJECT_DISABLE: "1",
      OPENCODE_DISABLE_CLAUDE_CODE: "1",
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      OPENCODE_DISABLE_FREE_MODELS: "1",
      OPENCODE_CONFIG_CONTENT: config,
    }).map(([name, value]) => [`${SERVE_ONLY_PREFIX}${name}`, value]),
  ),
});

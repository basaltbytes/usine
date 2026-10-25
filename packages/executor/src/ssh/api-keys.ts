import type { Harness } from "@usine/core/agent/brain";
import type { AttemptId } from "@usine/core/attempt";
import type { GatewayLlmProvider } from "@usine/core/worker";
import { Effect, Option, Redacted } from "effect";
import type { ExecutorOperation } from "../executor.ts";
import { type RemoteCommands, sendingShell } from "../remote/commands.ts";
import type { RemoteAccess } from "../remote/machine.ts";
import {
  attemptCodexHome,
  removeCodexHomeOnClose,
  writeMachineFiles,
} from "./gateway/attachments.ts";
import type { MachineGateway, SshMachine, SshWorkerAddress } from "./model.ts";

/** The provider each harness needs a credential from. Pi children run only on local Workers. */
const PROVIDER_OF_HARNESS = {
  claude: Option.some("anthropic"),
  codex: Option.some("openai"),
  pi: Option.none(),
} as const satisfies Record<Harness, Option.Option<GatewayLlmProvider>>;

/** The variable with the OpenAI API key that Codex's `model_provider` reads (`env_key`). */
const OPENAI_KEY_VARIABLE = "OPENAI_API_KEY";

/**
 * Codex's `config.toml` for an OpenAI API key in `OPENAI_API_KEY`: a `model_provider` that
 * sends the Responses API to `api.openai.com` and needs no login. The file contains no key.
 */
const CODEX_API_KEY_CONFIG = [
  'model_provider = "usine-openai"',
  "",
  "[model_providers.usine-openai]",
  'name = "OpenAI API key"',
  'base_url = "https://api.openai.com/v1"',
  `env_key = "${OPENAI_KEY_VARIABLE}"`,
  'wire_api = "responses"',
  "requires_openai_auth = false",
  "",
].join("\n");

/** Returns whether the Gateway holds a credential for `harness`'s provider. */
export const gatewayHolds = (gateway: Option.Option<MachineGateway>, harness: Harness): boolean =>
  Option.exists(gateway, ({ settings }) =>
    Option.exists(PROVIDER_OF_HARNESS[harness], (provider) =>
      settings.llmProviders.includes(provider),
    ),
  );

/**
 * Returns the API key that each Attempt on a Worker's machine gets for `harness`, or `None` if
 * the Worker isn't provisioned, the provisioner sets no key, or the Gateway has the provider's
 * credential.
 */
export const provisionedApiKey = (
  worker: { readonly address: SshWorkerAddress; readonly gateway: Option.Option<MachineGateway> },
  harness: Harness,
): Option.Option<Redacted.Redacted<string>> => {
  const { machine } = worker.address;
  if (machine._tag !== "Provisioned" || gatewayHolds(worker.gateway, harness)) return Option.none();
  return Option.flatMap(
    PROVIDER_OF_HARNESS[harness],
    (provider) => machine.provisioner.apiKeys[provider],
  );
};

/**
 * Returns `access` with the provisioner's API keys among the Attempt's secrets. With an OpenAI
 * key, also writes the Attempt's Codex home with `CODEX_API_KEY_CONFIG`, and removes it when the
 * caller's scope closes.
 */
export const withApiKeys = Effect.fn("SshExecutor.withApiKeys")(function* (
  commands: RemoteCommands,
  machine: SshMachine,
  attemptId: AttemptId,
  access: RemoteAccess,
  operation: ExecutorOperation,
) {
  const anthropic = provisionedApiKey(machine, "claude");
  const openai = provisionedApiKey(machine, "codex");
  const secrets = Object.fromEntries([
    ...Option.toArray(Option.map(anthropic, (key) => ["ANTHROPIC_API_KEY", key] as const)),
    ...Option.toArray(Option.map(openai, (key) => [OPENAI_KEY_VARIABLE, key] as const)),
  ]);
  if (Object.keys(secrets).length === 0) return access;
  const codexHome = Option.map(openai, () => attemptCodexHome(machine, attemptId));
  if (Option.isSome(codexHome)) {
    yield* removeCodexHomeOnClose(commands, machine, codexHome.value, {
      attemptId,
      worker: machine.address.name,
    });
    yield* writeMachineFiles(commands, operation, machine.shell, [
      [`${codexHome.value}/config.toml`, CODEX_API_KEY_CONFIG],
    ]);
  }
  const values = Object.values(secrets).map(Redacted.value);
  return {
    ...access,
    // An Attempt container gets the secrets when it starts; without one, the SSH connection
    // sends them.
    shell: sendingShell(access.shell, secrets),
    secrets: { ...access.secrets, ...secrets },
    writablePaths: [...access.writablePaths, ...Option.toArray(codexHome)],
    environment: Option.match(codexHome, {
      onNone: () => access.environment,
      onSome: (home) => ({ ...access.environment, CODEX_HOME: home }),
    }),
    scrub: (text: string) =>
      values.reduce(
        (scrubbed, value) => scrubbed.replaceAll(value, "<redacted>"),
        access.scrub(text),
      ),
  } satisfies RemoteAccess;
});

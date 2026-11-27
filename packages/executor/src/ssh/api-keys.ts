import { type HarnessCatalog } from "@usine/agents/harness";
import type { BrainSpec } from "@usine/core/agent/brain";
import type { ModelProvider } from "@usine/core/agent/provider";
import type { AttemptId } from "@usine/core/attempt";
import { Effect, Option, Redacted } from "effect";
import type { ExecutorOperation } from "../executor.ts";
import { type RemoteCommands, sendingShell } from "../remote/commands.ts";
import type { MachineCredentialRoute, RemoteAccess } from "../remote/machine.ts";
import type { AttemptHomes } from "./attempt-homes.ts";
import { writeMachineFiles } from "./gateway/attachments.ts";
import type { MachineGateway, SshMachine, SshWorkerAddress } from "./model.ts";

/**
 * Returns whether the Gateway holds the slot of the provider of `brain`'s model, and so injects the
 * credential that each Attempt's session of `brain` uses.
 */
export const gatewayHolds = (
  catalog: HarnessCatalog,
  gateway: Option.Option<Pick<MachineGateway, "settings">>,
  brain: BrainSpec,
): boolean =>
  Option.exists(gateway, ({ settings }) =>
    Option.isSome(catalog.modelGatewayProvider(brain, settings.llmProviders)),
  );

/** A provider API key that an Attempt gets, and its provider. */
export interface ProvisionedApiKey {
  readonly provider: ModelProvider;
  readonly key: Redacted.Redacted<string>;
}

/**
 * Returns the API key that each Attempt on a Worker's machine gets for `brain`: the provisioner's
 * key for the provider of its model, if an attempt API key reaches that provider. `None` if the
 * Worker isn't provisioned, the provisioner sets no such key, the provider is gateway-only, or the
 * Gateway holds the provider's slot.
 */
export const provisionedApiKey = (
  catalog: HarnessCatalog,
  worker: {
    readonly address: SshWorkerAddress;
    readonly gateway: Option.Option<Pick<MachineGateway, "settings">>;
  },
  brain: BrainSpec,
): Option.Option<ProvisionedApiKey> => {
  const { machine } = worker.address;
  if (machine._tag !== "Provisioned" || gatewayHolds(catalog, worker.gateway, brain))
    return Option.none();
  const { apiKeys } = machine.provisioner;
  return Option.flatMap(catalog.get(brain.harness), ({ apiKeyProviders }) =>
    Option.flatMap(
      Option.filter(catalog.modelProvider(brain), ({ id }) =>
        apiKeyProviders.some((reached) => reached.id === id),
      ),
      (provider) =>
        Option.map(Option.fromUndefinedOr(apiKeys[provider.id]), (key) => ({ provider, key })),
    ),
  );
};

/**
 * Returns how each Attempt's session of `brain` authenticates on a Worker's machine: through the
 * Gateway if it holds the slot of the model's provider, with the provisioner's API key if it sets
 * one for that provider, or with the SSH user's login otherwise.
 */
export const machineCredentialRoute = (
  catalog: HarnessCatalog,
  worker: {
    readonly address: SshWorkerAddress;
    readonly gateway: Option.Option<Pick<MachineGateway, "settings">>;
  },
  brain: BrainSpec,
): MachineCredentialRoute =>
  gatewayHolds(catalog, worker.gateway, brain)
    ? "gateway"
    : Option.isSome(provisionedApiKey(catalog, worker, brain))
      ? "api-key"
      : "host-login";

/** Adds the provisioner's API key for `brain`'s model, and its attempt configuration. */
export const withApiKeys = Effect.fn("SshExecutor.withApiKeys")(function* (
  catalog: HarnessCatalog,
  commands: RemoteCommands,
  holdAttemptHome: AttemptHomes["hold"],
  machine: SshMachine,
  attemptId: AttemptId,
  access: RemoteAccess,
  operation: ExecutorOperation,
  brain: Option.Option<BrainSpec>,
) {
  yield* Effect.annotateCurrentSpan({ attemptId, worker: machine.address.name });
  const keyed = Option.toArray(brain).flatMap((spec) =>
    Option.toArray(catalog.get(spec.harness)).flatMap((descriptor) =>
      Option.toArray(provisionedApiKey(catalog, machine, spec)).flatMap(({ provider, key }) =>
        Option.toArray(descriptor.worker.credential).map((credential) => ({
          descriptor,
          credential,
          provider,
          key,
        })),
      ),
    ),
  );
  if (keyed.length === 0) {
    yield* Effect.logDebug("No attempt API keys to inject", {
      attemptId,
      worker: machine.address.name,
    });
    return access;
  }
  const wirings = yield* Effect.forEach(keyed, ({ descriptor, credential, provider }) =>
    Effect.gen(function* () {
      const homes = yield* Effect.forEach(Option.toArray(credential.home), () =>
        holdAttemptHome(machine, attemptId, descriptor),
      );
      const wiring = credential.apiKey.render(credential.apiKeyBaseUrl(provider), homes[0] ?? "");
      if (wiring.files.length > 0)
        yield* writeMachineFiles(commands, operation, machine.shell, wiring.files);
      return { wiring, homes };
    }),
  );
  const secrets = Object.fromEntries(
    keyed.map(({ credential, key }) => [credential.apiKey.tokenVariable, key]),
  );
  yield* Effect.logInfo("Prepared attempt API-key wiring", {
    attemptId,
    worker: machine.address.name,
    harnesses: keyed.map(({ descriptor }) => descriptor.id),
    providers: keyed.map(({ provider }) => provider.id),
  });
  const values = Object.values(secrets).map(Redacted.value);
  return {
    ...access,
    // An Attempt container gets the secrets when it starts; without one, the SSH connection
    // sends them.
    shell: sendingShell(access.shell, secrets),
    secrets: { ...access.secrets, ...secrets },
    apiKeyHarnesses: new Set([
      ...access.apiKeyHarnesses,
      ...keyed.map(({ descriptor }) => descriptor.id),
    ]),
    writableMounts: [
      ...access.writableMounts,
      ...wirings.flatMap(({ homes }) => homes.map((home) => ({ source: home, destination: home }))),
    ],
    environment: {
      ...access.environment,
      ...Object.assign({}, ...wirings.map(({ wiring }) => wiring.environment)),
    },
    scrub: (text: string) =>
      values.reduce(
        (scrubbed, value) => scrubbed.replaceAll(value, "<redacted>"),
        access.scrub(text),
      ),
  } satisfies RemoteAccess;
});

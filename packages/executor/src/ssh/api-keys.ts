import { type HarnessCatalog } from "@usine/agents/harness";
import type { Harness } from "@usine/core/agent/brain";
import type { AttemptId } from "@usine/core/attempt";
import { Effect, Option, Redacted } from "effect";
import type { ExecutorOperation } from "../executor.ts";
import { type RemoteCommands, sendingShell } from "../remote/commands.ts";
import type { RemoteAccess } from "../remote/machine.ts";
import type { AttemptHomes } from "./attempt-homes.ts";
import { writeMachineFiles } from "./gateway/attachments.ts";
import type { MachineGateway, SshMachine, SshWorkerAddress } from "./model.ts";

/** Returns whether the Gateway holds a credential for `harness`'s provider. */
export const gatewayHolds = (
  catalog: HarnessCatalog,
  gateway: Option.Option<MachineGateway>,
  harness: Harness,
): boolean =>
  Option.exists(gateway, ({ settings }) =>
    Option.exists(
      Option.flatMap(catalog.get(harness), (descriptor) =>
        Option.map(descriptor.worker.credential, ({ protocol }) => protocol),
      ),
      (protocol) => settings.llmProviders.includes(protocol),
    ),
  );

/**
 * Returns the API key that each Attempt on a Worker's machine gets for `harness`, or `None` if
 * the Worker isn't provisioned, the provisioner sets no key, or the Gateway has the provider's
 * credential.
 */
export const provisionedApiKey = (
  catalog: HarnessCatalog,
  worker: { readonly address: SshWorkerAddress; readonly gateway: Option.Option<MachineGateway> },
  harness: Harness,
): Option.Option<Redacted.Redacted<string>> => {
  const { machine } = worker.address;
  if (machine._tag !== "Provisioned" || gatewayHolds(catalog, worker.gateway, harness))
    return Option.none();
  return Option.flatMap(
    Option.flatMap(catalog.get(harness), (descriptor) =>
      Option.map(descriptor.worker.credential, ({ provider }) => provider),
    ),
    (provider) => machine.provisioner.apiKeys[provider],
  );
};

/** Adds the selected harness's provisioner API key and attempt configuration. */
export const withApiKeys = Effect.fn("SshExecutor.withApiKeys")(function* (
  catalog: HarnessCatalog,
  commands: RemoteCommands,
  holdAttemptHome: AttemptHomes["hold"],
  machine: SshMachine,
  attemptId: AttemptId,
  access: RemoteAccess,
  operation: ExecutorOperation,
  harness: Option.Option<Harness>,
) {
  yield* Effect.annotateCurrentSpan({ attemptId, worker: machine.address.name });
  const keyed = catalog.descriptors
    .filter(({ id }) => Option.contains(harness, id))
    .flatMap((descriptor) =>
      Option.toArray(provisionedApiKey(catalog, machine, descriptor.id)).flatMap((key) =>
        Option.toArray(descriptor.worker.credential).map((credential) => ({
          descriptor,
          credential,
          key,
        })),
      ),
    );
  if (keyed.length === 0) {
    yield* Effect.logDebug("No attempt API keys to inject", {
      attemptId,
      worker: machine.address.name,
    });
    return access;
  }
  const wirings = yield* Effect.forEach(keyed, ({ descriptor, credential }) =>
    Effect.gen(function* () {
      const homes = yield* Effect.forEach(Option.toArray(credential.home), () =>
        holdAttemptHome(machine, attemptId, descriptor),
      );
      const wiring = credential.apiKey.render(credential.apiKeyBaseUrl, homes[0] ?? "");
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

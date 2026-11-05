import {
  catalog,
  CredentialWiring,
  HarnessCatalog,
  HarnessCredential,
  HarnessDescriptor,
  WorkerRequirements,
} from "@usine/agents/harness";
import { harnessesLiveFrom } from "@usine/agents/harness/node";
import { Harness } from "@usine/core/agent/brain";
import { assert } from "@effect/vitest";
import { Layer, Option } from "effect";

const codex = catalog.descriptors.find(({ id }) => id === "codex");
assert(codex !== undefined);
assert(Option.isSome(codex.worker.credential));
const wiring = CredentialWiring.make({
  tokenVariable: "SHARED_GATEWAY_TOKEN",
  environment: { SHARED_HOME: "{{home}}" },
  files: { "client.json": '{"base_url":"{{baseUrl}}","env_key":"SHARED_GATEWAY_TOKEN"}' },
});

export const sharedHarness = HarnessDescriptor.make({
  ...codex,
  id: Harness.make("shared-client"),
  label: "Shared client",
  worker: WorkerRequirements.make({
    ...codex.worker,
    credential: Option.some(
      HarnessCredential.make({
        ...codex.worker.credential.value,
        home: Option.some("SHARED_HOME"),
        gateway: wiring,
        apiKey: wiring,
      }),
    ),
  }),
});

export const sharedHarnesses = harnessesLiveFrom(
  HarnessCatalog.make({ descriptors: [...catalog.descriptors, sharedHarness] }),
  (runtimes) => {
    const codexRuntime = runtimes.find(({ id }) => id === "codex");
    assert(codexRuntime !== undefined);
    return [...runtimes, { ...codexRuntime, id: sharedHarness.id }];
  },
).pipe(Layer.orDie);

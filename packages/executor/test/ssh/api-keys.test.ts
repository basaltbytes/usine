import { assert, describe, it } from "@effect/vitest";
import { catalog } from "@usine/agents/harness";
import { BrainSpec, Harness, ModelId } from "@usine/core/agent/brain";
import { openai, opencodeGo } from "@usine/core/agent/provider";
import { Option, Redacted } from "effect";
import { machineCredentialRoute, provisionedApiKey } from "../../src/ssh/api-keys.ts";
import type { SshWorkerAddress } from "../../src/ssh/model.ts";
import { gatewayAddress } from "./gateway/support.ts";
import { hetznerSettings } from "./provisioner/support.ts";

const OPENAI_KEY = "sk-proj-openai-for-api-key-tests";
const GO_KEY = "go-key-for-api-key-tests";

const opencodeBrain = (model: string) =>
  BrainSpec.make({ harness: Harness.make("opencode"), model: ModelId.make(model), effort: "low" });

/** A provisioned Worker whose provisioner sets `apiKeys`, behind a Gateway that holds `llmProviders`. */
const provisioned = (
  apiKeys: Readonly<Record<string, string>>,
  llmProviders: Option.Option<ReadonlyArray<string>> = Option.none(),
) => {
  const behind = gatewayAddress({ llmProviders: Option.getOrElse(llmProviders, () => []) });
  const address: SshWorkerAddress = {
    ...behind,
    gateway: Option.isSome(llmProviders) ? behind.gateway : Option.none(),
    machine: {
      _tag: "Provisioned",
      provisioner: hetznerSettings({
        apiKeys: Object.fromEntries(
          Object.entries(apiKeys).map(([id, key]) => [id, Redacted.make(key)]),
        ),
      }),
    },
  };
  return {
    address,
    gateway: Option.map(address.gateway, (settings) => ({
      settings: { ...settings, egress: "proxy" as const },
    })),
  };
};

/** The provider and key that an Attempt of `brain` on `worker` gets, if any. */
const keyOf = (worker: ReturnType<typeof provisioned>, brain: BrainSpec) =>
  Option.map(provisionedApiKey(catalog, worker, brain), ({ provider, key }) => [
    provider.id,
    Redacted.value(key),
  ]);

describe("provisioned attempt API keys", () => {
  it("gives an OpenCode attempt no OpenCode Go key, which only the gateway reaches", () => {
    const goOnly = provisioned({ [opencodeGo.id]: GO_KEY });
    for (const model of ["gpt-test", "opencode-go/glm-5.3"]) {
      assert.deepStrictEqual(keyOf(goOnly, opencodeBrain(model)), Option.none());
      assert.strictEqual(
        machineCredentialRoute(catalog, goOnly, opencodeBrain(model)),
        "host-login",
      );
    }
    const both = provisioned({ [openai.id]: OPENAI_KEY, [opencodeGo.id]: GO_KEY });
    assert.deepStrictEqual(
      keyOf(both, opencodeBrain("gpt-test")),
      Option.some([openai.id, OPENAI_KEY]),
    );
    assert.deepStrictEqual(keyOf(both, opencodeBrain("opencode-go/glm-5.3")), Option.none());
  });

  it("chooses the route of the model's provider, not of the harness's first provider that the gateway holds", () => {
    // The gateway holds only the plan's slot, so an OpenAI model gets the provisioner's key.
    const goSlot = provisioned({ [openai.id]: OPENAI_KEY }, Option.some([opencodeGo.slot]));
    assert.deepStrictEqual(
      keyOf(goSlot, opencodeBrain("gpt-test")),
      Option.some([openai.id, OPENAI_KEY]),
    );
    assert.strictEqual(
      machineCredentialRoute(catalog, goSlot, opencodeBrain("gpt-test")),
      "api-key",
    );
    assert.strictEqual(
      machineCredentialRoute(catalog, goSlot, opencodeBrain("opencode-go/glm-5.3")),
      "gateway",
    );
    // The gateway holds only OpenAI's slot, so a Go model has no credential on the worker.
    const openaiSlot = provisioned({ [openai.id]: OPENAI_KEY }, Option.some([openai.slot]));
    assert.strictEqual(
      machineCredentialRoute(catalog, openaiSlot, opencodeBrain("gpt-test")),
      "gateway",
    );
    assert.deepStrictEqual(keyOf(openaiSlot, opencodeBrain("opencode-go/glm-5.3")), Option.none());
    assert.strictEqual(
      machineCredentialRoute(catalog, openaiSlot, opencodeBrain("opencode-go/glm-5.3")),
      "host-login",
    );
  });
});

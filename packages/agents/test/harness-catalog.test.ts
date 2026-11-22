import { assert, describe, it } from "@effect/vitest";
import { Harness } from "@usine/core/agent/brain";
import { BillingPool, PoolDescriptor } from "@usine/core/agent/pool";
import {
  anthropic,
  ApiKeyCredential,
  GatewayVariable,
  ModelProvider,
  modelProviders,
  openai,
} from "@usine/core/agent/provider";
import { Option, Schema } from "effect";
import {
  apiKeys,
  CapabilityProfile,
  catalog,
  HarnessCatalog,
  HarnessCredential,
  HarnessDescriptor,
  HarnessPool,
  WorkerRequirements,
  workerImageInputs,
} from "../src/harness/catalog.ts";
import { codex } from "../src/harness/codex/descriptor.ts";
import { pi } from "../src/harness/pi/descriptor.ts";
// Generated image inputs are checked against the source descriptors.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { readFileSync } from "node:fs";

describe("harness catalog", () => {
  it("admits a new ID by registration while refusing unregistered and malformed IDs", () => {
    const added = HarnessDescriptor.make({
      ...pi,
      id: Harness.make("new-harness"),
      label: "New harness",
    });
    const extended = HarnessCatalog.make({ descriptors: [...catalog.descriptors, added] });
    const decode = Schema.decodeOption(extended.harness);
    assert(Option.isNone(Schema.decodeOption(catalog.harness)(added.id)));
    assert.deepStrictEqual(decode(added.id), Option.some(added.id));
    assert.deepStrictEqual(extended.get(added.id), Option.some(added));
    assert(Option.isNone(decode("unknown")));
    assert(Option.isNone(decode("not a harness ID")));
    assert(Option.isNone(extended.get(Harness.make("unknown"))));
  });

  it("lists each declared pool once and refuses a pool ID with two definitions", () => {
    const testPlan = PoolDescriptor.make({
      id: BillingPool.make("testPlan"),
      label: "Test plan",
      billing: "plan",
      windows: "separately",
    });
    const declaring = (id: string, pool: PoolDescriptor) =>
      HarnessDescriptor.make({
        ...pi,
        id: Harness.make(id),
        pools: [...pi.pools, HarnessPool.make({ pool, routes: ["gateway-subscription"] })],
      });
    const extended = HarnessCatalog.make({
      descriptors: [
        ...catalog.descriptors,
        declaring("first-harness", testPlan),
        declaring("second-harness", testPlan),
      ],
    });
    assert.deepStrictEqual(extended.pools, [...catalog.pools, testPlan]);
    // Claude Code reports its five-hour and weekly windows one at a time; Codex reports both.
    assert.deepStrictEqual(
      catalog.pools.map(({ id, billing, windows }) => ({ id, billing, windows })),
      [
        { id: "apiKeys", billing: "metered", windows: "none" },
        { id: "claudePlan", billing: "plan", windows: "separately" },
        { id: "chatgptPlan", billing: "plan", windows: "together" },
      ],
    );
    const relabelled = PoolDescriptor.make({ ...testPlan, label: "Another plan" });
    assert(
      Option.isNone(
        HarnessCatalog.makeOption({
          descriptors: [declaring("first-harness", testPlan), declaring("other", relabelled)],
        }),
      ),
    );
    assert(
      Option.isNone(
        HarnessDescriptor.makeOption({
          ...pi,
          pools: [...pi.pools, HarnessPool.make({ pool: testPlan, routes: ["gateway-api-key"] })],
        }),
      ),
      "a route determines one pool",
    );
    assert(
      Option.isNone(
        HarnessDescriptor.makeOption({
          ...pi,
          pools: [
            ...pi.pools,
            HarnessPool.make({ pool: testPlan, routes: ["gateway-subscription"] }),
            HarnessPool.make({ pool: testPlan, routes: [] }),
          ],
        }),
      ),
      "a descriptor lists each pool once",
    );
    for (const windows of ["together", "separately"] as const)
      assert(
        Option.isNone(PoolDescriptor.makeOption({ ...apiKeys, windows })),
        "a metered pool has no plan windows",
      );
  });

  it("rejects duplicate IDs so registration and lookup cannot disagree", () => {
    assert(Option.isNone(HarnessCatalog.makeOption({ descriptors: [pi, pi] })));
  });

  it("adds worker packages and tag versions by registration, excluding bundled harnesses", () => {
    const added = HarnessDescriptor.make({
      ...pi,
      id: Harness.make("new-harness"),
      worker: WorkerRequirements.make({
        ...pi.worker,
        install: [
          { name: "new-harness", version: "1.2.3" },
          { name: "its-helper", version: "4.5.6" },
        ],
      }),
    });
    const inputs = workerImageInputs(catalog, "container");
    assert.deepStrictEqual(workerImageInputs(HarnessCatalog.make({ descriptors: [pi] }), "local"), {
      npmPackages: [],
      launcherPackages: [],
      tag: "",
    });
    assert.deepStrictEqual(
      workerImageInputs(
        HarnessCatalog.make({ descriptors: [...catalog.descriptors, added] }),
        "orchestrator",
      ),
      {
        npmPackages: [...inputs.npmPackages, "new-harness@1.2.3", "its-helper@4.5.6"],
        launcherPackages: [],
        tag: "claude-2.1.311-codex-0.164.0-new-harness-1.2.3-4.5.6",
      },
    );
  });

  it("installs a launcher into its own prefix only where its harness runs", () => {
    const launcher = HarnessDescriptor.make({
      ...pi,
      id: Harness.make("launched"),
      capabilities: [CapabilityProfile.make({ ...pi.capabilities[0], placements: ["container"] })],
      worker: WorkerRequirements.make({
        ...pi.worker,
        install: [{ name: "launched", version: "1.0.0", method: "launcher" }],
      }),
    });
    const source = HarnessCatalog.make({ descriptors: [codex, launcher] });
    assert.deepStrictEqual(workerImageInputs(source, "container"), {
      npmPackages: ["@openai/codex@0.164.0"],
      launcherPackages: ["launched@1.0.0"],
      tag: "codex-0.164.0-launched-1.0.0",
    });
    assert.deepStrictEqual(workerImageInputs(source, "sandbox"), {
      npmPackages: ["@openai/codex@0.164.0"],
      launcherPackages: [],
      tag: "codex-0.164.0",
    });
  });

  it("rejects credential file recipes without an attempt home and unsupported Cloudflare files", () => {
    assert(Option.isSome(codex.worker.credential));
    const credential = codex.worker.credential.value;
    assert(Option.isNone(HarnessCredential.makeOption({ ...credential, home: Option.none() })));
    assert(
      Option.isNone(
        HarnessCredential.makeOption({ ...credential, cloudflare: credential.gateway }),
      ),
    );
  });

  it("accepts an empty slot path or one of plain segments, and rejects any other", () => {
    assert(Option.isSome(codex.worker.credential));
    const credential = codex.worker.credential.value;
    for (const slotPath of ["/v1", "", "/api/v1beta"])
      assert(
        Option.isSome(HarnessCredential.makeOption({ ...credential, slotPath })),
        `accepts ${slotPath}`,
      );
    for (const slotPath of ["v1", "/v1/", "//v1", "/..", "openai-responses/v1"])
      assert(
        Option.isNone(HarnessCredential.makeOption({ ...credential, slotPath })),
        `rejects ${slotPath}`,
      );
  });

  it("gives a harness the Gateway's credential of the first provider it lists that the Gateway holds", () => {
    const claude = Harness.make("claude");
    const codexId = Harness.make("codex");
    const [anthropicSlot, openaiSlot] = [anthropic.slot, openai.slot];
    assert.isTrue(catalog.gatewayHolds(claude, [anthropicSlot]));
    assert.isTrue(catalog.gatewayHolds(codexId, [anthropicSlot, openaiSlot]));
    assert.isFalse(catalog.gatewayHolds(claude, [openaiSlot]));
    assert.isFalse(catalog.gatewayHolds(claude, []));
    // Pi has no credential wiring, and an unknown harness has no descriptor.
    assert.isFalse(catalog.gatewayHolds(pi.id, [anthropicSlot, openaiSlot]));
    assert.isFalse(catalog.gatewayHolds(Harness.make("unknown"), [anthropicSlot]));
    const both = HarnessDescriptor.make({
      ...codex,
      id: Harness.make("both-providers"),
      providers: [openai, anthropic],
    });
    const extended = HarnessCatalog.make({ descriptors: [...catalog.descriptors, both] });
    assert.deepStrictEqual(
      extended.gatewayProvider(both.id, [anthropicSlot, openaiSlot]),
      Option.some(openai),
    );
    assert.deepStrictEqual(
      extended.gatewayProvider(both.id, [anthropicSlot]),
      Option.some(anthropic),
    );
  });

  it("declares the providers that the gateway serves, once each, and refuses two definitions of one", () => {
    assert.deepStrictEqual(catalog.providers, modelProviders);
    const keyOnly = ModelProvider.make({
      ...openai,
      credentials: [ApiKeyCredential.make({ variable: GatewayVariable.make("OPENAI_API_KEY") })],
    });
    const declaring = (id: string, provider: ModelProvider) =>
      HarnessDescriptor.make({
        ...codex,
        id: Harness.make(id),
        providers: [provider],
        pools: [HarnessPool.make({ pool: apiKeys, routes: ["gateway-api-key"] })],
      });
    assert(
      Option.isNone(
        HarnessCatalog.makeOption({
          descriptors: [...catalog.descriptors, declaring("key-only", keyOnly)],
        }),
      ),
      "a provider ID has one definition",
    );
    assert(
      Option.isNone(HarnessDescriptor.makeOption({ ...codex, providers: [keyOnly] })),
      "a subscription pool needs a provider that accepts a subscription",
    );
    assert(
      Option.isNone(HarnessDescriptor.makeOption({ ...codex, providers: [] })),
      "credential wiring needs a provider",
    );
  });

  it("generates both Dockerfiles, cloud-init, and the published image tag from the descriptors", () => {
    const read = (path: string) =>
      readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");
    for (const [file, placement] of [
      ["infra/worker-image/Dockerfile", "container"],
      ["packages/cloudflare/image/Dockerfile", "sandbox"],
    ] as const) {
      const inputs = workerImageInputs(catalog, placement);
      const dockerfile = read(file);
      assert.include(dockerfile, `ARG HARNESS_PACKAGES="${inputs.npmPackages.join(" ")}"`);
      assert.match(dockerfile, /^RUN npm install -g .*\$\{HARNESS_PACKAGES\}/mu);
      if (inputs.launcherPackages.length === 0)
        assert.notInclude(dockerfile, "ARG HARNESS_LAUNCHERS=");
      else {
        assert.include(dockerfile, `ARG HARNESS_LAUNCHERS="${inputs.launcherPackages.join(" ")}"`);
        // A global install would get every optional platform package of a launcher.
        assert.match(
          dockerfile,
          /^\s+npm install --prefix (\S+) --omit=optional \$\{HARNESS_LAUNCHERS\} \\$/mu,
        );
        assert.notMatch(dockerfile, /npm install -g[^\n]*HARNESS_LAUNCHERS/u);
      }
    }
    // The sandbox image runs no harness without a sandbox placement.
    assert.notInclude(read("packages/cloudflare/image/Dockerfile"), "@opencode/cli");
    const ssh = workerImageInputs(catalog, "ssh");
    const cloudInit = read("infra/hetzner/cloud-init.yaml");
    assert.match(cloudInit, /^\s+npm install -g pnpm@\S+ /mu);
    assert.strictEqual(
      /^\s+npm install -g pnpm@\S+ (.*)$/mu.exec(cloudInit)?.[1],
      ssh.npmPackages.join(" "),
    );
    assert.strictEqual(
      /^\s+launchers="(.*)"$/mu.exec(cloudInit)?.[1],
      ssh.launcherPackages.join(" "),
    );
    assert.match(cloudInit, /^\s+npm install --prefix (\S+) --omit=optional \$launchers$/mu);
    assert.strictEqual(
      read("infra/worker-image/tag.txt"),
      `${workerImageInputs(catalog, "container").tag}\n`,
    );
  });
});

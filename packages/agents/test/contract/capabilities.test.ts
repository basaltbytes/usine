import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { BrainSpec, Harness, ModelId } from "@usine/core/agent/brain";
import { RoleName } from "@usine/core/agent/session";
import { Array as Arr, Effect, FileSystem, Option, Result, Schema } from "effect";
import { fileURLToPath } from "node:url";
import { admitBrain, AdmissionContext } from "../../src/harness/admission.ts";
import { Capability, CapabilityProfile } from "../../src/harness/capability.ts";
import { catalog } from "../../src/harness/catalog.ts";
import { HarnessCatalog, HarnessDescriptor } from "../../src/harness/harness.ts";
import { RolePlacements, RoleSpec } from "../../src/harness/role.ts";
import { fixtureFile, type Provider } from "../replay/fixture.ts";
import { Scenario } from "../replay/transcript.ts";
import { capabilityProofs, type Proof, replayedScenarios } from "./capabilities.ts";

const packageFile = (file: string) => fileURLToPath(new URL(`../../${file}`, import.meta.url));
const isScenario = Schema.is(Scenario);
const isCapability = Schema.is(Capability);
const isRecordedHarness = Schema.is(Schema.Literals(["claude", "codex", "pi"]));

/** Where `unproven` looks up the proofs, replayed scenarios, and fixtures of a harness. */
interface ProofSources {
  readonly proofs: typeof capabilityProofs;
  readonly replayed: (harness: Provider) => ReadonlyArray<Scenario>;
  readonly fixture: (harness: Provider, scenario: Scenario) => string;
}

const contractSuite: ProofSources = {
  proofs: capabilityProofs,
  replayed: (harness) => replayedScenarios(Harness.make(harness)),
  fixture: fixtureFile,
};

/** Why `descriptor` declares a capability that the contract suite doesn't prove for it. */
const unproven = (descriptor: HarnessDescriptor, sources: ProofSources = contractSuite) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const problems: Array<string> = [];
    const declared = new Set(descriptor.capabilities.flatMap(({ supported }) => supported));
    const harness: Option.Option<Provider> = isRecordedHarness(descriptor.id)
      ? Option.some(descriptor.id)
      : Option.none();
    for (const capability of declared) {
      const proof: Proof = sources.proofs[capability];
      if (proof._tag === "Suites") {
        const files = Option.flatMap(harness, (id) => Option.fromNullishOr(proof.files[id]));
        if (Option.isNone(files)) {
          problems.push(
            `${descriptor.label} declares ${capability}, but no suite checks it for ${descriptor.label}`,
          );
          continue;
        }
        for (const file of files.value)
          if (!(yield* fs.exists(packageFile(file))))
            problems.push(`${capability} names the missing suite ${file}`);
        continue;
      }
      for (const scenario of proof.scenarios) {
        const recorded =
          isScenario(scenario) &&
          Option.isSome(harness) &&
          sources.replayed(harness.value).includes(scenario) &&
          (yield* fs.exists(sources.fixture(harness.value, scenario)));
        if (!recorded)
          problems.push(
            `${descriptor.label} declares ${capability}, but its adapter passes no ${scenario} scenario`,
          );
      }
    }
    return problems;
  });

/** `harness`'s descriptor, with `capability` moved from lacking to supported in every profile. */
const overclaiming = (harness: Provider, capability: Capability) => {
  const descriptor = catalog.get(Harness.make(harness));
  assert(Option.isSome(descriptor));
  return HarnessDescriptor.make({
    ...descriptor.value,
    capabilities: Arr.map(descriptor.value.capabilities, (profile) =>
      CapabilityProfile.make({
        ...profile,
        supported: [...profile.supported, capability],
        lacking: profile.lacking.filter((gap) => gap.capability !== capability),
      }),
    ),
  });
};

/** The capabilities that `descriptor` declares and that `scenario` proves. */
const provenBy = (descriptor: HarnessDescriptor, scenario: Scenario) =>
  new Set(
    descriptor.capabilities.flatMap(({ supported }) =>
      supported.filter((capability) => {
        const proof: Proof = capabilityProofs[capability];
        return proof._tag === "Scenarios" && proof.scenarios.includes(scenario);
      }),
    ),
  );

const base = RoleSpec.make({
  name: RoleName.make("capability-probe"),
  placement: RolePlacements.make({
    placements: ["orchestrator", "local", "ssh", "container", "sandbox"],
    reason: "The probe runs anywhere",
  }),
  credential: Option.none(),
  nativeTools: true,
  hostTools: false,
  persistence: "saved",
  interventions: false,
  output: "text",
});

/** A role that requires `capability`, or `None` for one that only reports usage or checks. */
const requiring = (
  capability: Capability,
): Option.Option<{ readonly role: RoleSpec; readonly reopens: boolean }> => {
  const role = (
    fields: Partial<Pick<RoleSpec, "nativeTools" | "hostTools" | "persistence" | "output">> & {
      readonly interventions?: boolean;
    },
  ) => Option.some({ role: RoleSpec.make({ ...base, ...fields }), reopens: false });
  switch (capability) {
    case "usine-tools":
      return role({ hostTools: true });
    case "closed-tools":
      return role({ nativeTools: false });
    case "structured-output":
      return role({ output: "structured" });
    case "ephemeral":
      return role({ persistence: "ephemeral" });
    case "durable-coordination":
      return role({ persistence: "journaled" });
    case "steer":
    case "interrupt":
      return role({ interventions: true });
    case "resume-session":
      return Option.some({ role: base, reopens: true });
    case "token-usage":
      return role({});
    case "cost-usd":
    case "plan-windows":
    case "model-check":
      return Option.none();
  }
};

describe("harness capability declarations", () => {
  it.effect("declare only capabilities whose contract scenarios their adapters pass", () =>
    Effect.gen(function* () {
      for (const descriptor of catalog.descriptors) {
        const problems = yield* unproven(descriptor);
        assert.deepStrictEqual(problems, [], descriptor.label);
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("fail when a descriptor declares a capability without a passing scenario", () =>
    Effect.gen(function* () {
      const problems = yield* unproven(overclaiming("claude", "usine-tools"));
      assert.deepStrictEqual(problems, [
        "Claude Code declares usine-tools, but its adapter passes no host-tool scenario",
      ]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("fail when no suite checks a capability for the declaring harness", () =>
    Effect.gen(function* () {
      const problems = yield* unproven(overclaiming("claude", "model-check"));
      assert.deepStrictEqual(problems, [
        "Claude Code declares model-check, but no suite checks it for Claude Code",
      ]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("fail when the declaring harness has no fixture for a proving scenario", () =>
    Effect.gen(function* () {
      const codex = catalog.get(Harness.make("codex"));
      assert(Option.isSome(codex));
      // Claude Code's steer fixture exists, so only a lookup by Codex's own ID misses it.
      const problems = yield* unproven(codex.value, {
        ...contractSuite,
        fixture: (harness, scenario) =>
          harness === "codex" && scenario === "steer"
            ? packageFile("test/fixtures/replay/steer/missing.json")
            : fixtureFile(harness, scenario),
      });
      assert.isTrue(provenBy(codex.value, "steer").size > 0);
      assert.deepStrictEqual(
        problems,
        [...provenBy(codex.value, "steer")].map(
          (capability) => `Codex declares ${capability}, but its adapter passes no steer scenario`,
        ),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("fail when the declaring harness doesn't replay a proving scenario", () =>
    Effect.gen(function* () {
      const pi = catalog.get(Harness.make("pi"));
      assert(Option.isSome(pi));
      // Pi's restart fixture exists, but the replay suite no longer runs it.
      const problems = yield* unproven(pi.value, {
        ...contractSuite,
        replayed: (harness) =>
          contractSuite.replayed(harness).filter((scenario) => scenario !== "restart"),
      });
      assert.isTrue(provenBy(pi.value, "restart").size > 0);
      assert.deepStrictEqual(
        problems,
        [...provenBy(pi.value, "restart")].map(
          (capability) => `Pi declares ${capability}, but its adapter passes no restart scenario`,
        ),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it("refuse every role that needs a lacking capability with the descriptor's reason", () => {
    for (const descriptor of catalog.descriptors)
      for (const profile of descriptor.capabilities)
        for (const gap of profile.lacking) {
          const probe = isCapability(gap.capability) ? requiring(gap.capability) : Option.none();
          if (Option.isNone(probe)) continue;
          const refused = admitBrain(
            HarnessCatalog.make({ descriptors: [descriptor] }),
            probe.value.role,
            BrainSpec.make({ harness: descriptor.id, model: ModelId.make("probe"), effort: "low" }),
            AdmissionContext.make({
              placement: profile.placements[0],
              credential: profile.credentials[0],
            }),
            { reopens: probe.value.reopens },
          );
          assert(Result.isFailure(refused), `${descriptor.id} admits without ${gap.capability}`);
          assert.deepInclude(refused.failure.missing, gap);
        }
  });
});

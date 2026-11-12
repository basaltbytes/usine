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
import { fixtureFile } from "../replay/fixture.ts";
import { Scenario } from "../replay/transcript.ts";
import { capabilityProofs, replayedScenarios } from "./capabilities.ts";

const packageFile = (file: string) => fileURLToPath(new URL(`../../${file}`, import.meta.url));
const isScenario = Schema.is(Scenario);
const isCapability = Schema.is(Capability);
const isRecordedHarness = Schema.is(Schema.Literals(["claude", "codex", "pi"]));

/** Why `descriptor` declares a capability that the contract suite doesn't prove for it. */
const unproven = (descriptor: HarnessDescriptor) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const problems: Array<string> = [];
    const declared = new Set(descriptor.capabilities.flatMap(({ supported }) => supported));
    for (const capability of declared) {
      const proof = capabilityProofs[capability];
      if (proof._tag === "Suites") {
        for (const file of proof.files)
          if (!(yield* fs.exists(packageFile(file))))
            problems.push(`${capability} names the missing suite ${file}`);
        continue;
      }
      for (const scenario of proof.scenarios) {
        const recorded =
          isScenario(scenario) &&
          isRecordedHarness(descriptor.id) &&
          replayedScenarios(descriptor.id).includes(scenario) &&
          (yield* fs.exists(fixtureFile(descriptor.id, scenario)));
        if (!recorded)
          problems.push(
            `${descriptor.label} declares ${capability}, but its adapter passes no ${scenario} scenario`,
          );
      }
    }
    return problems;
  });

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
      const claude = catalog.get(Harness.make("claude"));
      assert(Option.isSome(claude));
      const overclaimed = HarnessDescriptor.make({
        ...claude.value,
        capabilities: Arr.map(claude.value.capabilities, (profile) =>
          CapabilityProfile.make({
            ...profile,
            supported: [...profile.supported, "usine-tools"],
            lacking: profile.lacking.filter(({ capability }) => capability !== "usine-tools"),
          }),
        ),
      });
      const problems = yield* unproven(overclaimed);
      assert.deepStrictEqual(problems, [
        "Claude Code declares usine-tools, but its adapter passes no host-tool scenario",
      ]);
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

import { assert, describe, it } from "@effect/vitest";
import { BrainSpec, Harness, ModelId } from "@usine/core/agent/brain";
import { RoleName } from "@usine/core/agent/session";
import { Array as Arr, Option, Result } from "effect";
import {
  admitBrain,
  AdmissionContext,
  CapabilityProfile,
  catalog,
  codingAgent,
  HarnessCatalog,
  HarnessDescriptor,
  Lacking,
  requirements,
  RoleCredentials,
  RolePlacements,
  RoleSpec,
} from "../src/harness/catalog.ts";

const onOrchestrator = (role: string) =>
  RolePlacements.make({
    placements: ["orchestrator"],
    reason: `The ${role} runs on the orchestrator host`,
  });

// The coordinator's declaration lives with the parent in `@usine/durable`, which depends on this
// package; this one states the same needs.
const coordinator = RoleSpec.make({
  name: RoleName.make("coordinator"),
  placement: onOrchestrator("coordinator"),
  credential: Option.none(),
  nativeTools: false,
  hostTools: true,
  persistence: "journaled",
  interventions: true,
  output: "text",
});

// The supervisor (#799) has no runtime yet, so only this test declares it.
const supervisor = RoleSpec.make({
  name: RoleName.make("supervisor"),
  placement: onOrchestrator("supervisor"),
  credential: Option.some(
    RoleCredentials.make({
      credentials: ["gateway", "gateway-subscription", "gateway-api-key"],
      reason:
        "The supervisor uses a gateway credential so subscription credentials stay on the gateway",
    }),
  ),
  nativeTools: true,
  hostTools: true,
  persistence: "saved",
  interventions: true,
  output: "text",
});

const brain = (harness: string) =>
  BrainSpec.make({
    harness: Harness.make(harness),
    model: ModelId.make("test/model"),
    effort: "high",
  });
const local = AdmissionContext.make({ placement: "local", credential: "host-login" });
const orchestrator = AdmissionContext.make({ placement: "orchestrator", credential: "host-login" });

describe("brain admission", () => {
  it("requires durable coordination, rather than a particular harness ID", () => {
    assert(Result.isSuccess(admitBrain(catalog, coordinator, brain("pi"), orchestrator)));
    for (const id of ["claude", "codex"]) {
      const result = admitBrain(catalog, coordinator, brain(id), orchestrator);
      assert(Result.isFailure(result));
      assert.strictEqual(result.failure.role, "coordinator");
      assert.strictEqual(result.failure.missing[0].capability, "durable-coordination");
      assert.include(result.failure.message, "durable journal");
    }
    const template = catalog.descriptors.find(({ id }) => id === "pi");
    assert(template !== undefined);
    const added = HarnessDescriptor.make({ ...template, id: Harness.make("journaled") });
    const extended = HarnessCatalog.make({ descriptors: [...catalog.descriptors, added] });
    assert(Result.isSuccess(admitBrain(extended, coordinator, brain("journaled"), orchestrator)));
  });

  it("admits coding agents on supported workers and returns adapter reasons for every remote Pi refusal", () => {
    for (const id of catalog.ids)
      assert(Result.isSuccess(admitBrain(catalog, codingAgent, brain(id), local)));
    for (const placement of ["ssh", "container", "sandbox"] as const) {
      const context = AdmissionContext.make({ placement, credential: "api-key" });
      for (const id of ["claude", "codex"])
        assert(Result.isSuccess(admitBrain(catalog, codingAgent, brain(id), context)));
      const result = admitBrain(catalog, codingAgent, brain("pi"), context);
      assert(Result.isFailure(result));
      assert.strictEqual(result.failure.missing[0].capability, placement);
      assert.include(result.failure.message, "Pi runs its tools in the orchestrator process");
    }
  });

  it("admits supervisors only on the orchestrator through gateway credentials", () => {
    for (const id of ["claude", "codex"]) {
      for (const credential of ["gateway", "gateway-subscription", "gateway-api-key"] as const) {
        assert(
          Result.isSuccess(
            admitBrain(
              catalog,
              supervisor,
              brain(id),
              AdmissionContext.make({ placement: "orchestrator", credential }),
            ),
          ),
        );
      }
      assert(Result.isFailure(admitBrain(catalog, supervisor, brain(id), orchestrator)));
      assert(
        Result.isFailure(
          admitBrain(
            catalog,
            supervisor,
            brain(id),
            AdmissionContext.make({ placement: "ssh", credential: "gateway" }),
          ),
        ),
      );
    }
    for (const credential of ["gateway", "gateway-subscription", "gateway-api-key"] as const) {
      for (const role of [coordinator, supervisor]) {
        assert(
          Result.isSuccess(
            admitBrain(
              catalog,
              role,
              brain("pi"),
              AdmissionContext.make({ placement: "orchestrator", credential }),
            ),
          ),
        );
      }
    }
  });

  it("refuses unregistered harnesses and unsupported credentials", () => {
    const unknown = admitBrain(catalog, codingAgent, brain("unknown"), local);
    assert(Result.isFailure(unknown));
    assert.strictEqual(unknown.failure.missing[0].capability, "registered-harness");
    const pi = admitBrain(
      catalog,
      codingAgent,
      brain("pi"),
      AdmissionContext.make({ placement: "local", credential: "api-key" }),
    );
    assert(Result.isFailure(pi));
    assert.strictEqual(pi.failure.missing[0].capability, "credential-route");
  });

  it("refuses a registered coding agent that lacks steering with its adapter reason", () => {
    const descriptor = catalog.descriptors[0];
    assert(descriptor !== undefined);
    const profile = descriptor.capabilities[0];
    const added = HarnessDescriptor.make({
      ...descriptor,
      id: Harness.make("no-steering"),
      capabilities: [
        CapabilityProfile.make({
          ...profile,
          supported: profile.supported.filter((value) => value !== "steer"),
          lacking: [
            ...profile.lacking,
            Lacking.make({
              capability: "steer",
              reason: "The transport cannot accept input during a turn",
            }),
          ],
        }),
      ],
    });
    const extended = HarnessCatalog.make({ descriptors: [added] });
    const result = admitBrain(extended, codingAgent, brain("no-steering"), local);
    assert(Result.isFailure(result));
    assert.strictEqual(result.failure.missing[0].capability, "steer");
    assert.include(result.failure.message, "The transport cannot accept input during a turn");
  });

  it("declares plan windows only for Claude and Codex subscription routes", () => {
    for (const descriptor of catalog.descriptors) {
      for (const profile of descriptor.capabilities) {
        assert.strictEqual(
          profile.supported.includes("plan-windows"),
          descriptor.id !== "pi" && profile.credentials.includes("gateway-subscription"),
        );
      }
    }
  });

  it("rejects incomplete or contradictory capability declarations", () => {
    const descriptor = catalog.descriptors[0];
    assert(descriptor !== undefined);
    const profile = descriptor.capabilities[0];
    assert(Option.isNone(CapabilityProfile.makeOption({ ...profile, supported: [] })));
    assert(
      Option.isNone(
        CapabilityProfile.makeOption({
          ...profile,
          lacking: [...profile.lacking, ...profile.lacking],
        }),
      ),
    );
    assert(
      Option.isNone(
        HarnessDescriptor.makeOption({ ...descriptor, capabilities: [profile, profile] }),
      ),
    );
    assert(
      Option.isNone(
        CapabilityProfile.makeOption({
          ...profile,
          lacking: [
            ...profile.lacking,
            Lacking.make({ capability: "steer", reason: "unsupported" }),
          ],
        }),
      ),
    );
  });

  it("admits and refuses a role declared here from its requirements", () => {
    // A short structured check that follows a coding agent on the API-key route.
    const reviewer = RoleSpec.make({
      name: RoleName.make("reviewer"),
      placement: RolePlacements.make({
        placements: ["local", "container"],
        reason: "The reviewer runs beside the coding agent it checks",
      }),
      credential: Option.some(
        RoleCredentials.make({
          credentials: ["api-key", "gateway-api-key"],
          reason: "The reviewer bills the coding agent's API key",
        }),
      ),
      nativeTools: false,
      hostTools: false,
      persistence: "ephemeral",
      interventions: false,
      output: "structured",
    });
    assert.deepStrictEqual(requirements(reviewer), [
      "closed-tools",
      "structured-output",
      "ephemeral",
      "token-usage",
    ]);
    const container = AdmissionContext.make({ placement: "container", credential: "api-key" });
    for (const id of ["claude", "codex"]) {
      const refused = admitBrain(catalog, reviewer, brain(id), container);
      assert(Result.isFailure(refused));
      assert.strictEqual(refused.failure.role, "reviewer");
      assert.deepStrictEqual(
        refused.failure.missing.map(({ capability }) => capability),
        ["closed-tools", "structured-output", "ephemeral"],
      );
    }
    const claude = catalog.get(Harness.make("claude"));
    assert(Option.isSome(claude));
    const capable = HarnessDescriptor.make({
      ...claude.value,
      id: Harness.make("capable"),
      capabilities: Arr.map(claude.value.capabilities, (profile) =>
        CapabilityProfile.make({
          ...profile,
          supported: [...profile.supported, "closed-tools", "structured-output", "ephemeral"],
          lacking: profile.lacking.filter(
            ({ capability }) =>
              !["closed-tools", "structured-output", "ephemeral"].includes(capability),
          ),
        }),
      ),
    });
    const extended = HarnessCatalog.make({ descriptors: [...catalog.descriptors, capable] });
    const admitted = admitBrain(
      extended,
      reviewer,
      brain("capable"),
      AdmissionContext.make({ placement: "local", credential: "gateway-api-key" }),
    );
    assert(Result.isSuccess(admitted));
    assert.strictEqual(admitted.success.role, reviewer);
    assert.deepStrictEqual(admitted.success.pool, Option.some("apiKeys"));
    const outside = admitBrain(
      extended,
      reviewer,
      brain("capable"),
      AdmissionContext.make({ placement: "ssh", credential: "host-login" }),
    );
    assert(Result.isFailure(outside));
    assert.deepStrictEqual(outside.failure.missing, [
      Lacking.make({
        capability: "local",
        reason: "The reviewer runs beside the coding agent it checks",
      }),
      Lacking.make({
        capability: "credential-route",
        reason: "The reviewer bills the coding agent's API key",
      }),
    ]);
    assert.include(
      outside.failure.message,
      "capable cannot run as reviewer at ssh: lacks local (The reviewer runs beside the coding agent it checks); lacks credential-route (The reviewer bills the coding agent's API key)",
    );
  });

  it("requires resume-session only to reopen a saved conversation", () => {
    assert.notInclude(requirements(codingAgent), "resume-session");
    assert.include(requirements(codingAgent, { reopens: true }), "resume-session");
    assert.deepStrictEqual(requirements(coordinator), [
      "durable-coordination",
      "steer",
      "interrupt",
      "token-usage",
    ]);
  });

  it("puts the pool that the credential route determines on the admitted brain", () => {
    const pools = (id: string) =>
      (
        ["host-login", "gateway", "gateway-subscription", "gateway-api-key", "api-key"] as const
      ).map((credential) => {
        const admitted = admitBrain(
          catalog,
          codingAgent,
          brain(id),
          AdmissionContext.make({ placement: "local", credential }),
        );
        return Result.isSuccess(admitted)
          ? Option.getOrElse(admitted.success.pool, () => "launch")
          : "refused";
      });
    // `launch`: the harness reports the pool of its own login or key when the session starts.
    assert.deepStrictEqual(pools("claude"), [
      "launch",
      "launch",
      "claudePlan",
      "apiKeys",
      "launch",
    ]);
    assert.deepStrictEqual(pools("codex"), [
      "launch",
      "launch",
      "chatgptPlan",
      "apiKeys",
      "launch",
    ]);
  });
});

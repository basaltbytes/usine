import { assert, describe, it } from "@effect/vitest";
import { BrainSpec, Harness, ModelId } from "@usine/core/agent/brain";
import { Option, Result } from "effect";
import {
  admitBrain,
  AdmissionContext,
  CapabilityProfile,
  catalog,
  HarnessCatalog,
  HarnessDescriptor,
  Lacking,
} from "../src/harness/catalog.ts";

const brain = (harness: string) =>
  BrainSpec.make({
    harness: Harness.make(harness),
    model: ModelId.make("test/model"),
    effort: "high",
  });
const local = AdmissionContext.make({ placement: "local", credential: "host-login" });
const coordinator = AdmissionContext.make({ placement: "orchestrator", credential: "host-login" });

describe("brain admission", () => {
  it("requires durable coordination, rather than a particular harness ID", () => {
    assert(Result.isSuccess(admitBrain(catalog, "coordinator", brain("pi"), coordinator)));
    for (const id of ["claude", "codex"]) {
      const result = admitBrain(catalog, "coordinator", brain(id), coordinator);
      assert(Result.isFailure(result));
      assert.strictEqual(result.failure.role, "coordinator");
      assert.strictEqual(result.failure.missing[0].capability, "durable-coordination");
      assert.include(result.failure.message, "durable journal");
    }
    const template = catalog.descriptors.find(({ id }) => id === "pi");
    assert(template !== undefined);
    const added = HarnessDescriptor.make({ ...template, id: Harness.make("journaled") });
    const extended = HarnessCatalog.make({ descriptors: [...catalog.descriptors, added] });
    assert(Result.isSuccess(admitBrain(extended, "coordinator", brain("journaled"), coordinator)));
  });

  it("admits coding agents on supported workers and returns adapter reasons for every remote Pi refusal", () => {
    for (const id of catalog.ids)
      assert(Result.isSuccess(admitBrain(catalog, "coding-agent", brain(id), local)));
    for (const placement of ["ssh", "container", "sandbox"] as const) {
      const context = AdmissionContext.make({ placement, credential: "api-key" });
      for (const id of ["claude", "codex"])
        assert(Result.isSuccess(admitBrain(catalog, "coding-agent", brain(id), context)));
      const result = admitBrain(catalog, "coding-agent", brain("pi"), context);
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
              "supervisor",
              brain(id),
              AdmissionContext.make({ placement: "orchestrator", credential }),
            ),
          ),
        );
      }
      assert(Result.isFailure(admitBrain(catalog, "supervisor", brain(id), coordinator)));
      assert(
        Result.isFailure(
          admitBrain(
            catalog,
            "supervisor",
            brain(id),
            AdmissionContext.make({ placement: "ssh", credential: "gateway" }),
          ),
        ),
      );
    }
    assert(
      Result.isFailure(
        admitBrain(
          catalog,
          "supervisor",
          brain("pi"),
          AdmissionContext.make({ placement: "orchestrator", credential: "gateway-subscription" }),
        ),
      ),
    );
  });

  it("refuses unregistered harnesses and unsupported credentials", () => {
    const unknown = admitBrain(catalog, "coding-agent", brain("unknown"), local);
    assert(Result.isFailure(unknown));
    assert.strictEqual(unknown.failure.missing[0].capability, "registered-harness");
    const pi = admitBrain(
      catalog,
      "coding-agent",
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
    const result = admitBrain(extended, "coding-agent", brain("no-steering"), local);
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
});

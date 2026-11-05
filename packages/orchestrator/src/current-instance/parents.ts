import { DurableHarness } from "@usine/durable/harness";
import { Effect, Layer } from "effect";
import { parentAdmissionProblems } from "../parent-admission.ts";
import { CurrentInstance } from "./current-instance.ts";

/** Checks startup brains and admits configuration revisions before they are stored or applied. */
export const parentAdmissionLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const harness = yield* DurableHarness;
    const instances = yield* CurrentInstance;
    yield* instances.registerParentAdmission((loaded) => parentAdmissionProblems(loaded, harness));
  }),
);

import { Harness } from "@usine/core/agent/brain";
import { Option } from "effect";
import { HarnessDescriptor, WorkerRequirements } from "../harness.ts";

export const pi = HarnessDescriptor.make({
  id: Harness.make("pi"),
  capabilities: ["resume-session"],
  label: "Pi",
  worker: WorkerRequirements.make({
    install: [],
    versions: [],
    login: { mounted: [], seeded: [] },
    credential: Option.none(),
  }),
  prices: Option.none(),
  handoff: null,
});

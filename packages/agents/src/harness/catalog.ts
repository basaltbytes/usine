import { claude } from "./claude/descriptor.ts";
import { codex } from "./codex/descriptor.ts";
import { HarnessCatalog, HarnessPresentation } from "./harness.ts";
import { pi } from "./pi/descriptor.ts";

/** The registered harnesses. Importing the catalog loads no vendor SDK or platform adapter. */
export const catalog = HarnessCatalog.make({ descriptors: [claude, codex, pi] });

/** Metadata for operator clients, in catalog order. */
export const harnessPresentations = catalog.descriptors.map((descriptor) =>
  HarnessPresentation.make(descriptor),
);

export {
  HarnessCredential,
  HarnessCatalog,
  HarnessDescriptor,
  HarnessPresentation,
  ResumeCommand,
  WorkerRequirements,
} from "./harness.ts";

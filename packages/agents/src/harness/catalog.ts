import { claude } from "./claude/descriptor.ts";
import { codex } from "./codex/descriptor.ts";
import { HarnessCatalog, HarnessPresentation } from "./harness.ts";
import { pi } from "./pi/descriptor.ts";

/** The registered harnesses. Importing the catalog loads no vendor SDK or platform adapter. */
export const catalog = HarnessCatalog.make({ descriptors: [claude, codex, pi] });

/** Returns worker npm packages and an image tag in catalog order. */
export const workerImageInputs = (source: HarnessCatalog) => {
  const installed = source.descriptors.filter(({ worker }) => worker.install.length > 0);
  return {
    npmPackages: installed.flatMap(({ worker }) =>
      worker.install.map(({ name, version }) => `${name}@${version}`),
    ),
    tag: installed
      .map(({ id, worker }) => [id, ...worker.install.map(({ version }) => version)].join("-"))
      .join("-"),
  };
};

/** Metadata for operator clients, in catalog order. */
export const harnessPresentations = catalog.descriptors.map((descriptor) =>
  HarnessPresentation.make(descriptor),
);

export { admitBrain, AdmittedBrain, AdmissionContext, BrainRefused } from "./admission.ts";
export { codingAgent, workerAdmissionContext, type WorkerSession } from "./launch.ts";
export { requirements, RoleCredentials, RolePlacements, RoleSpec } from "./role.ts";
export {
  Capability,
  CapabilityProfile,
  CredentialRoute,
  Lacking,
  Placement,
} from "./capability.ts";

export {
  CredentialWiring,
  HarnessCredential,
  HarnessCatalog,
  HarnessDescriptor,
  HarnessPresentation,
  ResumeCommand,
  WorkerRequirements,
} from "./harness.ts";

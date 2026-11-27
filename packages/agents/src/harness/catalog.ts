import { Option } from "effect";
import type { Placement } from "./capability.ts";
import { claude } from "./claude/descriptor.ts";
import { codex } from "./codex/descriptor.ts";
import { HarnessCatalog, HarnessPresentation } from "./harness.ts";
import { opencode } from "./opencode/descriptor.ts";
import { pi } from "./pi/descriptor.ts";

/** The registered harnesses. Importing the catalog loads no vendor SDK or platform adapter. */
export const catalog = HarnessCatalog.make({ descriptors: [claude, codex, pi, opencode] });

/**
 * Returns the npm packages and the image tag, in catalog order, of a worker image for `placement`:
 * the harnesses that run at that placement and install packages. `npmPackages` install globally,
 * and `launcherPackages` without their optional dependencies into a prefix of their own.
 */
export const workerImageInputs = (source: HarnessCatalog, placement: Placement) => {
  const installed = source.descriptors.filter(
    ({ worker, capabilities }) =>
      worker.install.length > 0 &&
      capabilities.some(({ placements }) => placements.includes(placement)),
  );
  const packages = (method: "global" | "launcher") =>
    installed.flatMap(({ worker }) =>
      worker.install
        .filter((entry) => entry.method === method)
        .map(({ name, version }) => `${name}@${version}`),
    );
  return {
    npmPackages: packages("global"),
    launcherPackages: packages("launcher"),
    tag: installed
      .map(({ id, worker }) => [id, ...worker.install.map(({ version }) => version)].join("-"))
      .join("-"),
  };
};

/** Metadata for operator clients, in catalog order. */
export const harnessPresentations = catalog.descriptors.map(
  ({ id, label, handoff, ownToolsKept }) =>
    HarnessPresentation.make({ id, label, handoff, ownTools: Option.getOrNull(ownToolsKept) }),
);

export { admitBrain, AdmittedBrain, AdmissionContext, BrainRefused } from "./admission.ts";
export { codingAgent, workerAdmissionContext, type WorkerSession } from "./launch.ts";
export { admitSupervisor, supervisor, supervisorAgent } from "./supervisor/role.ts";
export { requirements, RoleCredentials, RolePlacements, RoleSpec } from "./role.ts";
export { apiKeys, HarnessPool } from "./pool.ts";
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
  ModelChoice,
  ResumeCommand,
  WorkerRequirements,
} from "./harness.ts";

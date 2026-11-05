import { Option } from "effect";
import { claude } from "./claude/descriptor.ts";
import { codex } from "./codex/descriptor.ts";
import { HarnessCatalog, HarnessPresentation } from "./harness.ts";
import { pi } from "./pi/descriptor.ts";

/** The registered harnesses. Importing the catalog loads no vendor SDK or platform adapter. */
export const catalog = HarnessCatalog.make({ descriptors: [claude, codex, pi] });

/** Caller-token variables required by registered gateway wiring, in catalog order. */
export const gatewayTokenVariables = (source: HarnessCatalog): ReadonlyArray<string> => [
  ...new Set(
    source.descriptors.flatMap(({ worker }) =>
      Option.toArray(worker.credential).map(({ gateway }) => gateway.tokenVariable),
    ),
  ),
];

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

export {
  CredentialWiring,
  HarnessCapability,
  HarnessCredential,
  HarnessCatalog,
  HarnessDescriptor,
  HarnessPresentation,
  ResumeCommand,
  WorkerRequirements,
} from "./harness.ts";

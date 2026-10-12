import type { InstanceDirectory } from "@usine/core/instance";
import type { Path } from "effect";

/** Where the durable harness keeps its storage: `.usine/durable.sqlite`, next to the runtime store. */
export const durableStoragePath = (path: Path.Path, instanceDirectory: InstanceDirectory): string =>
  path.join(instanceDirectory, ".usine", "durable.sqlite");

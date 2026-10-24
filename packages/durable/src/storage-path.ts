import type { InstanceDirectory } from "@usine/core/instance";
import type { Path } from "effect";

export const durableStoragePath = (path: Path.Path, instanceDirectory: InstanceDirectory): string =>
  path.join(instanceDirectory, ".usine", "durable.sqlite");

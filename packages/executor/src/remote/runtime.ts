import { Schema } from "effect";

export const ContainerRuntime = Schema.Literals(["docker", "podman"]);
export type ContainerRuntime = typeof ContainerRuntime.Type;

/** Keeps host-owned mounts writable and scopes cgroup reads to this container. */
export const runtimeOptions = (runtime: ContainerRuntime): ReadonlyArray<string> =>
  runtime === "podman" ? ["--userns=keep-id", "--cgroupns=private", "--http-proxy=false"] : [];

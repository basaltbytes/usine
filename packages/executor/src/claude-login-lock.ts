import { ClaudeLoginLock } from "@usine/agents/runtime";
import type { WorkerName } from "@usine/core/worker";
import { Layer } from "effect";
import { keyedLockFor } from "./keyed-lock.ts";

/**
 * A `ClaudeLoginLock` with one mutex per Worker name. Each build is a new set
 * of locks, so build it once per process and provide it to both the executor
 * and the Attempt runtime that runs Claude children.
 */
export const claudeLoginLockLayer: Layer.Layer<ClaudeLoginLock> = Layer.effect(
  ClaudeLoginLock,
  keyedLockFor<WorkerName>(),
);

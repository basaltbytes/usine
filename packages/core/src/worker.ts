import { Schema } from "effect";

/** The engine-owned Worker adapters available to an instance. */
export const WORKER_KINDS = ["local", "exe.dev"] as const;
export const WorkerKind = Schema.Literals(WORKER_KINDS);
export type WorkerKind = typeof WorkerKind.Type;

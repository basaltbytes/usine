import { Schema } from "effect";

/** The name-keyed identity of a configured Worker. */
export const WorkerName = Schema.String.check(
  Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u, {
    message: "Expected a kebab-case Worker name",
  }),
).pipe(Schema.brand("WorkerName"));

export type WorkerName = typeof WorkerName.Type;

/** The engine-owned Worker adapters available to an instance. */
export const WORKER_KINDS = ["local", "exe.dev"] as const;
export const WorkerKind = Schema.Literals(WORKER_KINDS);
export type WorkerKind = typeof WorkerKind.Type;

import { Schema } from "effect";

/** The engine-owned Worker adapters available to an instance. */
export const KINDS = ["local", "exe.dev"] as const;
export const Kind = Schema.Literals(KINDS);
export type Kind = typeof Kind.Type;

/** Value object: the name-keyed identity of a configured Worker. */
export const Name = Schema.String.check(
  Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u, {
    message: "Expected a kebab-case Worker name",
  }),
).pipe(Schema.brand("WorkerName"));
export type Name = typeof Name.Type;

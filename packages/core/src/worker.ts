import { Schema } from "effect";

/** Value object: the name-keyed identity of a configured Worker. */
export const Name = Schema.String.check(
  Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u, {
    message: "Expected a kebab-case Worker name",
  }),
).pipe(Schema.brand("WorkerName"));
export type Name = typeof Name.Type;

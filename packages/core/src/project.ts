import { Schema } from "effect";

/** A project's kebab-case identifier, used to group managed repos and their loops. */
export const ProjectId = Schema.String.check(
  Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u, { message: "Expected a project slug" }),
).pipe(Schema.brand("ProjectId"));
export type ProjectId = typeof ProjectId.Type;

import { Schema } from "effect";

export const SetupState = Schema.Union([
  Schema.TaggedStruct("NoApp", {}),
  Schema.TaggedStruct("MissingKey", { message: Schema.String }),
  Schema.TaggedStruct("NeedsInstallation", {
    url: Schema.String,
    message: Schema.String,
  }),
  Schema.TaggedStruct("Repositories", {
    signIn: Schema.Boolean,
    github: Schema.Boolean,
  }),
  Schema.TaggedStruct("Ready", {}),
]);
export type SetupState = typeof SetupState.Type;

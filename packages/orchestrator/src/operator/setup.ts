import { Schema } from "effect";

export const SetupState = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("NoApp") }),
  Schema.Struct({ _tag: Schema.Literal("MissingKey"), message: Schema.String }),
  Schema.Struct({
    _tag: Schema.Literal("NeedsInstallation"),
    url: Schema.String,
    message: Schema.String,
  }),
  Schema.Struct({
    _tag: Schema.Literal("Repositories"),
    signIn: Schema.Boolean,
    github: Schema.Boolean,
  }),
  Schema.Struct({ _tag: Schema.Literal("Ready") }),
]);
export type SetupState = typeof SetupState.Type;

import type { PluginOptions } from "babel-plugin-react-compiler";

export const compilerOptions = {
  target: "19",
  environment: { validateNoSetStateInEffects: true },
} satisfies PluginOptions;

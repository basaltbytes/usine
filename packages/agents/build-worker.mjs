import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { ownerProgram } from "./src/child-host/worker/program.ts";

const bundle = async (entry, globalName) => {
  const options = {
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    target: "node22",
    format: "iife",
    minify: true,
    legalComments: "none",
    write: false,
  };
  if (globalName !== undefined) options.globalName = globalName;
  const result = await build(options);
  return result.outputFiles[0].text;
};

const generate = async (path, generated) => {
  if (
    (await readFile(path, "utf8").catch((error) => {
      if (error.code === "ENOENT") return "";
      throw error;
    })) !== generated
  )
    await writeFile(path, generated);
};

const lifeline = await bundle("src/child-host/worker/lifeline.ts");
const owner = await bundle("src/child-host/worker/owner.ts", "ChildHostWorker");
const program = ownerProgram({ owner, lifeline });
const bridge = await bundle("src/harness/opencode/bridge/main.ts");
await generate(
  "src/child-host/programs.ts",
  `export const PROCESS_OWNER: string = ${JSON.stringify(program)};\nexport const CHILD_LIFELINE: string = ${JSON.stringify(lifeline)};\n`,
);
await generate(
  "src/harness/opencode/bridge/bundle.ts",
  `export const OPENCODE_BRIDGE: string = ${JSON.stringify(bridge)};\n`,
);
if (process.argv.includes("--dist")) {
  await mkdir("dist/child-host/worker", { recursive: true });
  await writeFile("dist/child-host/worker/owner.cjs", program);
  await writeFile("dist/child-host/worker/lifeline.cjs", lifeline);
  await mkdir("dist/harness/opencode/bridge", { recursive: true });
  await writeFile("dist/harness/opencode/bridge/main.cjs", bridge);
}

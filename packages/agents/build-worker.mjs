import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { ownerProgram } from "./src/child-host/worker/program.ts";

const bundle = async (entry, globalName) => {
  const options = {
    entryPoints: [`src/child-host/worker/${entry}.ts`],
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

const lifeline = await bundle("lifeline");
const owner = await bundle("owner", "ChildHostWorker");
const program = ownerProgram({ owner, lifeline });
const generated = `export const PROCESS_OWNER: string = ${JSON.stringify(program)};\nexport const CHILD_LIFELINE: string = ${JSON.stringify(lifeline)};\n`;
const generatedPath = "src/child-host/programs.ts";
if (
  (await readFile(generatedPath, "utf8").catch((error) => {
    if (error.code === "ENOENT") return "";
    throw error;
  })) !== generated
)
  await writeFile(generatedPath, generated);
if (process.argv.includes("--dist")) {
  await mkdir("dist/child-host/worker", { recursive: true });
  await writeFile("dist/child-host/worker/owner.cjs", program);
  await writeFile("dist/child-host/worker/lifeline.cjs", lifeline);
}

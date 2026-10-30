import { readFile, writeFile } from "node:fs/promises";
import { operatorOpenApi } from "../server/src/openapi.ts";

const target = new URL("./public/openapi.json", import.meta.url);
const generated = `${JSON.stringify(operatorOpenApi(), null, 2)}\n`;
if (process.argv.includes("--check")) {
  const committed = await readFile(target, "utf8");
  if (committed !== generated) {
    process.stderr.write(
      "OpenAPI document is stale. Run pnpm --filter @usine/docs openapi:generate and commit public/openapi.json.\n",
    );
    process.exitCode = 1;
  }
} else {
  await writeFile(target, generated);
}

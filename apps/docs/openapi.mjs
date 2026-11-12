import { readFile, writeFile } from "node:fs/promises";
import { PERMISSION_EXTENSION, operatorOpenApi } from "../server/src/openapi.ts";

const target = new URL("./public/openapi.json", import.meta.url);
const document = operatorOpenApi();
const unmarked = Object.entries(document.paths).flatMap(([path, methods]) =>
  Object.entries(methods)
    .filter(([, operation]) => "responses" in operation && !(PERMISSION_EXTENSION in operation))
    .map(([method]) => `${method.toUpperCase()} ${path}`),
);
if (unmarked.length > 0) {
  process.stderr.write(
    `These operations have no ${PERMISSION_EXTENSION}. Add them to the permission map of their group in apps/server/src/openapi.ts:\n${unmarked.join("\n")}\n`,
  );
  process.exitCode = 1;
}
const generated = `${JSON.stringify(document, null, 2)}\n`;
if (process.argv.includes("--check")) {
  const committed = await readFile(target, "utf8");
  if (committed !== generated) {
    process.stderr.write(
      "OpenAPI document is stale. Run pnpm --filter @usine/docs openapi:generate and commit public/openapi.json.\n",
    );
    process.exitCode = 1;
  }
} else if (unmarked.length === 0) {
  await writeFile(target, generated);
}

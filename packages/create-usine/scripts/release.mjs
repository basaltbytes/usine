import { readFile, writeFile } from "node:fs/promises";

const read = async (path) => JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
const { version } = await read("../package.json");
const { version: serverVersion } = await read("../../../apps/server/package.json");
await writeFile(
  new URL("../dist/release.json", import.meta.url),
  `${JSON.stringify({ version, serverVersion }, null, 2)}\n`,
);

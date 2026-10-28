import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(packageRoot, "../web/dist");
const target = resolve(packageRoot, "dist/web");

await rm(target, { force: true, recursive: true });
await mkdir(target, { recursive: true });
await cp(source, target, { force: true, recursive: true });

await mkdir(resolve(packageRoot, "dist/upgrade"), { recursive: true });
await cp(
  resolve(packageRoot, "src/upgrade/helper.sh"),
  resolve(packageRoot, "dist/upgrade/helper.sh"),
);

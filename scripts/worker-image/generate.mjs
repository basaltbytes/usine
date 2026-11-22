import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { catalog, workerImageInputs } from "../../packages/agents/dist/harness/catalog.js";

const root = new URL("../../", import.meta.url);
const { packageManager } = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
const pnpm = /^pnpm@([^+\s]+)/u.exec(packageManager)?.[1];
if (!pnpm) throw new Error(`Unexpected packageManager in package.json: ${packageManager}`);
const check = process.argv.includes("--check");
const outputs = [];

/**
 * Replaces the line that `pattern` matches in `source` with `line`. Fails when the line is missing
 * and `required`, and otherwise leaves `source` as it is.
 */
const replaceLine = (file, source, pattern, line, required = true) => {
  if (pattern.test(source)) return source.replace(pattern, line);
  if (required) throw new Error(`Missing ${pattern} in ${file}`);
  return source;
};

const pnpmArgument = /^ARG PNPM_VERSION=.*$/mu;
const pnpmInstall = /^(RUN npm install -g pnpm@)\S+/mu;
// The attempt image runs container placements; the sandbox image runs Cloudflare sandboxes.
for (const [file, placement] of [
  ["infra/worker-image/Dockerfile", "container"],
  ["packages/cloudflare/image/Dockerfile", "sandbox"],
]) {
  const { npmPackages, npmPackagesWithoutOptional } = workerImageInputs(catalog, placement);
  let source = readFileSync(new URL(file, root), "utf8");
  source = replaceLine(
    file,
    source,
    /^ARG HARNESS_PACKAGES=.*$/mu,
    `ARG HARNESS_PACKAGES="${npmPackages.join(" ")}"`,
  );
  source = replaceLine(
    file,
    source,
    /^ARG HARNESS_PACKAGES_WITHOUT_OPTIONAL=.*$/mu,
    `ARG HARNESS_PACKAGES_WITHOUT_OPTIONAL="${npmPackagesWithoutOptional.join(" ")}"`,
    npmPackagesWithoutOptional.length > 0,
  );
  if (![pnpmArgument, pnpmInstall].some((pattern) => pattern.test(source)))
    throw new Error(`Missing pnpm version in ${file}`);
  outputs.push([
    file,
    source.replace(pnpmArgument, `ARG PNPM_VERSION=${pnpm}`).replace(pnpmInstall, `$1${pnpm}`),
  ]);
}

const cloudInit = "infra/hetzner/cloud-init.yaml";
const ssh = workerImageInputs(catalog, "ssh");
let source = readFileSync(new URL(cloudInit, root), "utf8");
source = replaceLine(
  cloudInit,
  source,
  /^(\s+npm install -g pnpm@).*$/mu,
  `$1${pnpm} ${ssh.npmPackages.join(" ")}`,
);
source = replaceLine(
  cloudInit,
  source,
  /^(\s+npm install -g --omit=optional ).*$/mu,
  `$1${ssh.npmPackagesWithoutOptional.join(" ")}`,
  ssh.npmPackagesWithoutOptional.length > 0,
);
outputs.push([cloudInit, source]);
outputs.push(["infra/worker-image/tag.txt", `${workerImageInputs(catalog, "container").tag}\n`]);

for (const [file, expected] of outputs) {
  const path = new URL(file, root);
  if (existsSync(path) && readFileSync(path, "utf8") === expected) continue;
  if (check) {
    console.error(`${file}: run pnpm worker-image:generate`);
    process.exitCode = 1;
  } else {
    writeFileSync(path, expected);
    console.log(`Generated ${file}`);
  }
}

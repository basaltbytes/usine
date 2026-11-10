import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { catalog, workerImageInputs } from "../../packages/agents/dist/harness/catalog.js";

const root = new URL("../../", import.meta.url);
const { npmPackages, tag } = workerImageInputs(catalog);
const packages = npmPackages.join(" ");
const { packageManager } = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
const pnpm = /^pnpm@([^+\s]+)/u.exec(packageManager)?.[1];
if (!pnpm) throw new Error(`Unexpected packageManager in package.json: ${packageManager}`);
const check = process.argv.includes("--check");
const outputs = [];

const pnpmArgument = /^ARG PNPM_VERSION=.*$/mu;
const pnpmInstall = /^(RUN npm install -g pnpm@)\S+/mu;
for (const file of ["infra/worker-image/Dockerfile", "packages/cloudflare/image/Dockerfile"]) {
  const source = readFileSync(new URL(file, root), "utf8");
  const argument = /^ARG HARNESS_PACKAGES=.*$/mu;
  if (!argument.test(source)) throw new Error(`Missing HARNESS_PACKAGES argument in ${file}`);
  if (![pnpmArgument, pnpmInstall].some((pattern) => pattern.test(source)))
    throw new Error(`Missing pnpm version in ${file}`);
  outputs.push([
    file,
    source
      .replace(argument, `ARG HARNESS_PACKAGES="${packages}"`)
      .replace(pnpmArgument, `ARG PNPM_VERSION=${pnpm}`)
      .replace(pnpmInstall, `$1${pnpm}`),
  ]);
}

const cloudInit = "infra/hetzner/cloud-init.yaml";
const source = readFileSync(new URL(cloudInit, root), "utf8");
const install = /^(\s+npm install -g pnpm@).*$/mu;
if (!install.test(source)) throw new Error(`Missing npm install line in ${cloudInit}`);
outputs.push([cloudInit, source.replace(install, `$1${pnpm} ${packages}`)]);
outputs.push(["infra/worker-image/tag.txt", `${tag}\n`]);

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

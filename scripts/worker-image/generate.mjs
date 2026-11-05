import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  catalog,
  gatewayTokenVariables,
  workerImageInputs,
} from "../../packages/agents/dist/harness/catalog.js";

const root = new URL("../../", import.meta.url);
const { npmPackages, tag } = workerImageInputs(catalog);
const packages = npmPackages.join(" ");
const check = process.argv.includes("--check");
const outputs = [];

for (const file of ["infra/worker-image/Dockerfile", "packages/cloudflare/image/Dockerfile"]) {
  const source = readFileSync(new URL(file, root), "utf8");
  const argument = /^ARG HARNESS_PACKAGES=.*$/mu;
  if (!argument.test(source)) throw new Error(`Missing HARNESS_PACKAGES argument in ${file}`);
  outputs.push([file, source.replace(argument, `ARG HARNESS_PACKAGES="${packages}"`)]);
}

const cloudInit = "infra/hetzner/cloud-init.yaml";
const source = readFileSync(new URL(cloudInit, root), "utf8");
const install = /^(\s+npm install -g pnpm@\S+).*$/mu;
if (!install.test(source)) throw new Error(`Missing npm install line in ${cloudInit}`);
outputs.push([cloudInit, source.replace(install, `$1 ${packages}`)]);
const gatewayCloudInit = "infra/hetzner/gateway/worker-cloud-init.yaml";
const gatewaySource = readFileSync(new URL(gatewayCloudInit, root), "utf8");
const acceptEnv = /^(\s+AcceptEnv GIT_CONFIG_VALUE_0 GH_ENTERPRISE_TOKEN GH_TOKEN).*$/mu;
if (!acceptEnv.test(gatewaySource))
  throw new Error(`Missing AcceptEnv line in ${gatewayCloudInit}`);
outputs.push([
  gatewayCloudInit,
  gatewaySource.replace(acceptEnv, `$1 ${gatewayTokenVariables(catalog).join(" ")}`),
]);
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

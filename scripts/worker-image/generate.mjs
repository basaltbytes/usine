import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { catalog, workerImageInputs } from "../../packages/agents/dist/harness/catalog.js";

const root = new URL("../../", import.meta.url);
const { packageManager } = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
const pnpm = /^pnpm@([^+\s]+)/u.exec(packageManager)?.[1];
if (!pnpm) throw new Error(`Unexpected packageManager in package.json: ${packageManager}`);
const check = process.argv.includes("--check");
const outputs = [];

/**
 * Replaces the line that `pattern` matches in `source` with `line`. When the line is missing,
 * `missing: "fail"` fails and `missing: "keep"` leaves `source` as it is.
 */
const replaceLine = (file, source, pattern, line, { missing }) => {
  if (pattern.test(source)) return source.replace(pattern, line);
  if (missing === "fail") throw new Error(`Missing ${pattern} in ${file}`);
  return source;
};

const pnpmArgument = /^ARG PNPM_VERSION=.*$/mu;
const pnpmInstall = /^(RUN npm install -g pnpm@)\S+/mu;
// The attempt image runs container placements; the sandbox image runs Cloudflare sandboxes.
for (const [file, placement] of [
  ["infra/worker-image/Dockerfile", "container"],
  ["packages/cloudflare/image/Dockerfile", "sandbox"],
]) {
  const { npmPackages, launcherPackages } = workerImageInputs(catalog, placement);
  let source = readFileSync(new URL(file, root), "utf8");
  source = replaceLine(
    file,
    source,
    /^ARG HARNESS_PACKAGES=.*$/mu,
    `ARG HARNESS_PACKAGES="${npmPackages.join(" ")}"`,
    { missing: "fail" },
  );
  // An image without launchers, such as the sandbox image, has no launcher argument.
  source = replaceLine(
    file,
    source,
    /^ARG HARNESS_LAUNCHERS=.*$/mu,
    `ARG HARNESS_LAUNCHERS="${launcherPackages.join(" ")}"`,
    { missing: launcherPackages.length > 0 ? "fail" : "keep" },
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
  { missing: "fail" },
);
source = replaceLine(
  cloudInit,
  source,
  /^(\s+launchers=).*$/mu,
  `$1"${ssh.launcherPackages.join(" ")}"`,
  { missing: "fail" },
);
outputs.push([cloudInit, source]);

/**
 * Returns the first 12 hexadecimal digits of the SHA-256 digest of the attempt image's build files,
 * with the generated content of those in `outputs`. The tests and the tag aren't build files.
 */
const imageContent = () => {
  const directory = "infra/worker-image/";
  const generated = new Map(outputs);
  const hash = createHash("sha256");
  for (const name of readdirSync(new URL(directory, root), { recursive: true }).sort()) {
    const file = `${directory}${name}`;
    if (
      name === "tag.txt" ||
      name.split("/")[0] === "test" ||
      !statSync(new URL(file, root)).isFile()
    )
      continue;
    hash
      .update(`${name}\0`)
      .update(generated.get(file) ?? readFileSync(new URL(file, root)))
      .update("\0");
  }
  return hash.digest("hex").slice(0, 12);
};

// A change to the image changes its tag, so that a worker that has the earlier image pulls it.
const content = imageContent();
const executorImage = "packages/executor/src/ssh/container.ts";
outputs.push([
  executorImage,
  replaceLine(
    executorImage,
    readFileSync(new URL(executorImage, root), "utf8"),
    /^const ATTEMPT_IMAGE_CONTENT = ".*";$/mu,
    `const ATTEMPT_IMAGE_CONTENT = "${content}";`,
    { missing: "fail" },
  ),
]);
outputs.push([
  "infra/worker-image/tag.txt",
  `${workerImageInputs(catalog, "container").tag}-${content}\n`,
]);

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

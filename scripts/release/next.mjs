import { execFile, execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { unpublishedPackages } from "./registry.mjs";

const log = (event, fields) => console.log(JSON.stringify({ event, ...fields }));

export async function publishNext({ run, sha, runAttempt, packages }, { command, wait, registry }) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const suffix = `next.${run}.g${sha.slice(0, 7)}.${runAttempt}.${attempt}`;
    const versions = packages.map(({ file, manifest }) => {
      const [major, minor, patch] = manifest.version.split("-")[0].split(".").map(Number);
      const version = `${major}.${minor}.${patch + 1}-${suffix}`;
      writeFileSync(file, `${JSON.stringify({ ...manifest, version }, null, 2)}\n`);
      return { name: manifest.name, version };
    });
    log("next_publish_started", { attempt, suffix, packages: versions });
    const build = await command(["build"]);
    if (build.code !== 0) throw new Error(`Snapshot build failed (exit ${build.code})`);

    const result = await command([
      "-r",
      "publish",
      "--tag",
      "next",
      "--no-git-checks",
      "--provenance",
    ]);
    let reason;
    if (result.code !== 0) {
      if (/\bTLOG_CREATE_ENTRY_ERROR\b[^\n]*\(409\)/u.test(result.output)) {
        reason = "sigstore_conflict";
      } else if (/Cannot publish over previously staged version/iu.test(result.output)) {
        reason = "staged_version_conflict";
      } else {
        throw new Error(`Snapshot publish failed (exit ${result.code}); see pnpm output`);
      }
    } else {
      // A successful upload can still be unavailable to installers.
      for (let check = 1; check <= 6; check++) {
        const pending = await unpublishedPackages(versions, registry);
        if (pending.length === 0) {
          log("next_publish_completed", { attempt, suffix });
          return;
        }
        log("next_publish_not_public", { attempt, check, packages: pending });
        if (check < 6) await wait(10_000);
      }
      reason = "versions_not_public";
    }
    if (attempt === 3) {
      log("next_publish_exhausted", { attempt, suffix, reason });
      throw new Error(
        "Snapshot publish failed after 3 attempts; inspect the logged versions on npm",
      );
    }
    const delayMs = attempt * 15_000;
    log("next_publish_retry", { attempt, nextAttempt: attempt + 1, reason, delayMs });
    await wait(delayMs);
  }
}

function command(args) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "pnpm",
      args,
      { maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error && !Number.isInteger(error.code)) {
          reject(error);
        } else {
          resolve({ code: error?.code ?? 0, output: `${stdout}\n${stderr}` });
        }
      },
    );
    child.stdout.pipe(process.stdout);
    child.stderr.pipe(process.stderr);
  });
}

if (import.meta.main) {
  const [run, sha, runAttempt] = process.argv.slice(2);
  if (
    !/^[1-9]\d*$/u.test(run ?? "") ||
    !/^[0-9a-f]{7,40}$/u.test(sha ?? "") ||
    !/^[1-9]\d*$/u.test(runAttempt ?? "")
  ) {
    console.error("Usage: node scripts/release/next.mjs <run number> <commit sha> <run attempt>");
    process.exit(64);
  }
  const packages = JSON.parse(
    execFileSync("pnpm", ["list", "--recursive", "--depth", "-1", "--json"], { encoding: "utf8" }),
  )
    .filter((member) => member.private === false)
    .map(({ path }) => {
      const file = join(path, "package.json");
      return { file, manifest: JSON.parse(readFileSync(file, "utf8")) };
    });
  await publishNext(
    { run, sha, runAttempt, packages },
    {
      command,
      wait: setTimeout,
      registry: "https://registry.npmjs.org/",
    },
  );
}

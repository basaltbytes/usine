import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

const exec = promisify(execFile);
const script = new URL("../install-boxd.sh", import.meta.url).pathname;

const binary = (version) => `#!/bin/sh\necho 'boxd ${version}'\n`;
const sha256 = (content) => createHash("sha256").update(content).digest("hex");

// Serves files of SERVED_DIR by the last path segment of the URL; fails like
// `curl -f` when the file is missing.
const fakeCurl = `#!/bin/sh
out=
url=
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) out=$2; shift;;
    -*) ;;
    *) url=$1;;
  esac
  shift
done
file="$SERVED_DIR/\${url##*/}"
[ -f "$file" ] || { echo "curl: (22) The requested URL returned error: 404" >&2; exit 22; }
if [ -n "$out" ]; then cp "$file" "$out"; else cat "$file"; fi
`;

const fakeDpkg = `#!/bin/sh
echo "$FAKE_ARCH"
`;

const setUp = async (t, { arch = "amd64", served } = {}) => {
  const directory = await mkdtemp(join(tmpdir(), "install-boxd-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bin = join(directory, "bin");
  const servedDir = join(directory, "served");
  const installDir = join(directory, "install");
  await Promise.all([mkdir(bin), mkdir(servedDir), mkdir(installDir)]);
  await writeFile(join(bin, "curl"), fakeCurl, { mode: 0o755 });
  await writeFile(join(bin, "dpkg"), fakeDpkg, { mode: 0o755 });
  if (served !== undefined) {
    await writeFile(join(servedDir, `boxd-linux-${arch}`), binary(served));
    await writeFile(
      join(servedDir, `latest-linux-${arch}.json`),
      JSON.stringify({ version: served, sha256: sha256(binary(served)) }),
    );
  }
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    SERVED_DIR: servedDir,
    FAKE_ARCH: arch,
    BOXD_INSTALL_DIR: installDir,
    BOXD_VERSION: "0.3.3",
    BOXD_SHA256_AMD64: sha256(binary("0.3.3")),
    BOXD_SHA256_ARM64: sha256(binary("0.3.3-arm64")),
  };
  return { env, installed: join(installDir, "boxd") };
};

const exists = (path) =>
  stat(path).then(
    () => true,
    () => false,
  );

test("installs the binary that matches the pinned checksum and version", async (t) => {
  const { env, installed } = await setUp(t, { served: "0.3.3" });
  const { stdout, stderr } = await exec(script, [], { env });
  assert.equal(await readFile(installed, "utf8"), binary("0.3.3"));
  assert.equal((await stat(installed)).mode & 0o777, 0o755);
  assert.match(stdout, /boxd CLI 0\.3\.3 installed/);
  assert.equal(stderr, "");
});

test("installs nothing and warns with both versions when boxd serves a newer binary", async (t) => {
  const { env, installed } = await setUp(t, { served: "0.3.4" });
  const { stderr } = await exec(script, [], { env });
  assert.equal(await exists(installed), false);
  assert.match(stderr, /the checksum doesn't match/);
  assert.match(stderr, /pins boxd 0\.3\.3; boxd serves 0\.3\.4/);
});

test("installs nothing when the checksum matches but the version pin doesn't", async (t) => {
  const { env, installed } = await setUp(t, { served: "0.3.3" });
  const { stderr } = await exec(script, [], { env: { ...env, BOXD_VERSION: "0.3.4" } });
  assert.equal(await exists(installed), false);
  assert.match(stderr, /the binary reports "boxd 0\.3\.3"/);
  assert.match(stderr, /pins boxd 0\.3\.4; boxd serves 0\.3\.3/);
});

test("installs nothing when the download fails", async (t) => {
  const { env, installed } = await setUp(t);
  const { stderr } = await exec(script, [], { env });
  assert.equal(await exists(installed), false);
  assert.match(stderr, /the download failed/);
  assert.match(stderr, /boxd serves an unknown version/);
});

test("checks the arm64 binary against the arm64 checksum", async (t) => {
  const { env, installed } = await setUp(t, { arch: "arm64", served: "0.3.3" });
  const { stderr } = await exec(script, [], { env });
  assert.equal(await exists(installed), false);
  assert.match(stderr, /the checksum doesn't match/);
});

test("fails on an architecture without a boxd binary", async (t) => {
  const { env } = await setUp(t, { arch: "riscv64" });
  await assert.rejects(exec(script, [], { env }), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /boxd has no Linux binary for riscv64/);
    return true;
  });
});

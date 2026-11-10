import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { Schema } from "effect";
import { parse } from "yaml";

const exec = promisify(execFile);
const script = new URL("../egress.mjs", import.meta.url).pathname;
const gatewayAllowlist = new URL("../../hetzner/gateway/egress-allowlist", import.meta.url);

const render = async (t, text) => {
  const work = await mkdtemp(join(tmpdir(), "boxd-egress-test-"));
  t.after(() => rm(work, { recursive: true, force: true }));
  const file = join(work, "egress-allowlist");
  await writeFile(file, text);
  return exec(process.execPath, [script, file]);
};

test("renders every host of the gateway's allowlist, with Tailscale first", async () => {
  const { stdout } = await exec(process.execPath, [script]);
  const { egress } = parse(stdout);
  const hosts = (await readFile(gatewayAllowlist, "utf8"))
    .split("\n")
    .map((line) => line.replace(/#.*$/u, "").trim())
    .filter(Boolean);
  assert.ok(hosts.length > 0);
  assert.deepEqual(egress, ["*.tailscale.com", ...hosts]);
});

test("quotes wildcards, lowercases hosts, and lists Tailscale once", async (t) => {
  const { stdout } = await render(
    t,
    "# comment\n\nRegistry.npmjs.org\n*.pythonhosted.org # inline\n*.tailscale.com\n",
  );
  assert.equal(
    stdout,
    'egress:\n  - "*.tailscale.com"\n  - "registry.npmjs.org"\n  - "*.pythonhosted.org"\n',
  );
  assert.deepEqual(parse(stdout).egress, [
    "*.tailscale.com",
    "registry.npmjs.org",
    "*.pythonhosted.org",
  ]);
});

test("refuses a rule with a port, which a boxd allowlist can't express", async (t) => {
  const failure = await render(t, "registry.npmjs.org\nproxy.example.com:8443\n").then(
    () => assert.fail("expected the script to fail"),
    (error) => error,
  );
  assert.equal(failure.code, 2);
  assert.match(failure.stderr, /Line 2: boxd allowlists have no ports/u);
});

test("refuses a rule that isn't a host name", async (t) => {
  const failure = await render(t, "localhost\n").then(
    () => assert.fail("expected the script to fail"),
    (error) => error,
  );
  assert.equal(failure.code, 2);
  assert.match(failure.stderr, /Line 1: expected a host name/u);
});

test("renders a list that the boxd provisioner's schema accepts", async () => {
  const { BoxdEgressAllowlist } = await import(
    new URL("../../../packages/core/src/worker.ts", import.meta.url)
  );
  const { stdout } = await exec(process.execPath, [script]);
  const decoded = Schema.decodeUnknownSync(BoxdEgressAllowlist)(parse(stdout).egress);
  assert.ok(decoded.includes("*.tailscale.com"));
});

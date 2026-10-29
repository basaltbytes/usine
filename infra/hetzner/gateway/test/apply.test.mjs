import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse, stringify } from "yaml";

function fixture(t, edit = () => {}) {
  const work = mkdtempSync(join(tmpdir(), "gateway-apply-test-"));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const gateway = join(work, "gateway");
  cpSync(new URL("../", import.meta.url), gateway, { recursive: true });
  symlinkSync(new URL("../../../../node_modules", import.meta.url), join(work, "node_modules"));
  cpSync(
    new URL("../../orchestrator-nftables.conf", import.meta.url),
    join(work, "orchestrator-nftables.conf"),
  );
  const script = join(gateway, "gateway.sh");
  const template = join(gateway, "gateway-cloud-init.yaml");
  const document = parse(readFileSync(template, "utf8"));
  edit(document);
  writeFileSync(template, stringify(document, { lineWidth: 0 }));
  const state = {};
  for (const file of document.write_files) {
    let content = file.content
      .replaceAll("@@DOMAIN@@", "test.internal")
      .replaceAll("@@GATEWAY_IP@@", "10.55.0.2")
      .replaceAll("@@NETWORK_CIDR@@", "10.55.0.0/16");
    if (content === "@@GATEWAY_NFTABLES_B64@@") {
      content = readFileSync(join(gateway, "gateway-nftables.conf"), "utf8").replace(
        "define network = 10.42.0.0/16",
        "define network = 10.55.0.0/16",
      );
    } else if (content === "@@EGRESS_ALLOWLIST_B64@@") {
      content = "operator.example\n";
    } else if (file.encoding === "b64") {
      content = Buffer.from(content, "base64");
    }
    state[file.path] = {
      content: Buffer.from(content).toString("base64"),
      mode: Number.parseInt(file.permissions ?? "0644", 8).toString(8),
      owner: file.owner ?? "root:root",
    };
  }
  const bin = join(work, "bin");
  mkdirSync(bin);
  cpSync(new URL("./ssh.mjs", import.meta.url), join(bin, "ssh"));
  chmodSync(join(bin, "ssh"), 0o755);
  const stateFile = join(work, "state.json");
  const log = join(work, "ssh.log");
  const identity = join(work, "identity with spaces");
  writeFileSync(identity, "fixture");
  const run = (args = [], env = {}) => {
    writeFileSync(log, "");
    writeFileSync(stateFile, JSON.stringify(state));
    const result = spawnSync("sh", [script, "apply", ...args], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        DOMAIN: "test.internal",
        GATEWAY_IP: "10.55.0.2",
        NETWORK_CIDR: "10.55.0.0/16",
        GATEWAY_SSH: "gateway-alias",
        SSH_STATE: stateFile,
        SSH_LOG: log,
        ...env,
      },
      encoding: "utf8",
    });
    const calls = readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    return {
      ...result,
      calls,
      commands: calls.map((call) => call.at(-1)),
      state: JSON.parse(readFileSync(stateFile, "utf8")),
    };
  };
  return { run, state, identity };
}

const writes = (result) => result.commands.filter((command) => command.startsWith("set -eu"));
const reloads = (result) =>
  result.commands.filter((command) => /^(systemctl |nft |sshd |sysctl )/.test(command));
const success = (result) => assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
const stale = (state, path) => {
  state[path].content = Buffer.from("old configuration\n").toString("base64");
};

test("dry run prints rendered diffs and preserves the remote files and services", (t) => {
  const f = fixture(t);
  stale(f.state, "/etc/nftables.conf");
  delete f.state["/etc/usine-gateway/settings.env"];
  const result = f.run(["-i", f.identity, "--dry-run"]);
  success(result);
  assert.match(result.stdout, /-old configuration/);
  assert.match(result.stdout, /\+define network = 10\.55\.0\.0\/16/);
  assert.match(result.stdout, /\+USINE_GATEWAY_DOMAIN=test.internal/);
  assert.match(result.stdout, /\+USINE_GATEWAY_EGRESS_HOST=10\.55\.0\.2/);
  assert.deepEqual(result.state, f.state);
  assert.deepEqual(writes(result), []);
  assert.deepEqual(reloads(result), []);
  for (const args of result.calls)
    assert.deepEqual(args.slice(0, -1), [
      "-i",
      f.identity,
      "-o",
      "IdentitiesOnly=yes",
      "gateway-alias",
    ]);
});

for (const [path, expected] of [
  ["/etc/nftables.conf", ["nft -f /etc/nftables.conf"]],
  ["/etc/dnsmasq.d/usine-gateway.conf", ["systemctl restart dnsmasq"]],
  ["/etc/default/dnsmasq", ["systemctl restart dnsmasq"]],
  ["/etc/usine-gateway/settings.env", ["systemctl restart usine-gateway"]],
  [
    "/etc/systemd/system/usine-gateway.service",
    ["systemctl daemon-reload", "systemctl restart usine-gateway"],
  ],
  ["/etc/chrony/conf.d/usine-gateway.conf", ["systemctl restart chrony"]],
  ["/etc/ssh/sshd_config.d/50-usine-gateway.conf", ["sshd -t && systemctl reload ssh"]],
  ["/etc/sysctl.d/90-usine-gateway.conf", ["sysctl -p /etc/sysctl.d/90-usine-gateway.conf"]],
  ["/usr/local/sbin/usine-gateway-install", []],
  ["/usr/local/sbin/usine-gateway-setup", []],
]) {
  test(`applies ${path} and runs only its reloads`, (t) => {
    const f = fixture(t);
    const desired = structuredClone(f.state);
    stale(f.state, path);
    const result = f.run();
    success(result);
    assert.deepEqual(result.state, desired);
    assert.equal(writes(result).length, 1);
    assert.deepEqual(reloads(result), expected);
    Object.assign(f.state, result.state);
    const repeated = f.run();
    success(repeated);
    assert.deepEqual(writes(repeated), []);
    assert.deepEqual(reloads(repeated), []);
    assert.match(repeated.stdout, /unchanged/);
  });
}

test("applies YAML ownership and permissions when only metadata differs", (t) => {
  const f = fixture(t, (document) => {
    const file = document.write_files.find(
      (file) => file.path === "/etc/usine-gateway/settings.env",
    );
    file.owner = "root:usine-gateway";
    file.permissions = "0640";
  });
  f.state["/etc/usine-gateway/settings.env"].owner = "root:root";
  f.state["/etc/usine-gateway/settings.env"].mode = "644";
  const result = f.run();
  success(result);
  assert.equal(result.state["/etc/usine-gateway/settings.env"].mode, "640");
  assert.equal(result.state["/etc/usine-gateway/settings.env"].owner, "root:usine-gateway");
  assert.equal(writes(result).length, 1);
});

test("never reads or overwrites gateway-owned files, even if the template lists them", (t) => {
  const f = fixture(t, (document) => {
    for (const path of ["/etc/usine-gateway/secrets.env", "/var/lib/usine-gateway/codex-auth.json"])
      document.write_files.push({ path, content: "private credential" });
  });
  const result = f.run();
  success(result);
  assert.deepEqual(result.state, f.state);
  assert.deepEqual(writes(result), []);
  assert.ok(
    result.commands.every(
      (command) => !/egress-allowlist|secrets.env|codex-auth.json/.test(command),
    ),
  );
  assert.doesNotMatch(result.stdout + result.stderr, /private credential/);
});

test("reloads the systemd unit before restarting once for unit and settings changes", (t) => {
  const f = fixture(t);
  for (const path of [
    "/etc/usine-gateway/settings.env",
    "/etc/systemd/system/usine-gateway.service",
  ])
    stale(f.state, path);
  const result = f.run();
  success(result);
  assert.deepEqual(reloads(result), ["systemctl daemon-reload", "systemctl restart usine-gateway"]);
});

test("refuses a non-root SSH user and prints a root command with the identity", (t) => {
  const f = fixture(t);
  const result = f.run(["-i", f.identity], {
    SSH_UID: "1000",
    GATEWAY_SSH: "operator@gateway-alias",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /GATEWAY_SSH='root@gateway-alias'/);
  assert.ok(result.stderr.includes(f.identity));
  assert.deepEqual(result.commands, ["id -u"]);
});

test("a failed remote read aborts before any file is written", (t) => {
  const f = fixture(t);
  stale(f.state, "/etc/nftables.conf");
  const result = f.run([], { SSH_FAIL: "stat -c '%a %U:%G' -- '/etc/usine-gateway/settings.env'" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /SSH fixture failure/);
  assert.deepEqual(result.state, f.state);
  assert.deepEqual(writes(result), []);
});

test("reload failures report the command and recovery after the file is copied", (t) => {
  const f = fixture(t);
  stale(f.state, "/etc/nftables.conf");
  const result = f.run([], { SSH_FAIL: "nft -f" });
  assert.equal(result.status, 1);
  assert.notDeepEqual(result.state, f.state);
  assert.match(result.stderr, /nft -f \/etc\/nftables.conf/);
  assert.match(result.stderr, /even if the next diff is empty/);
});

test("creates a missing file with the rendered contents and YAML mode", (t) => {
  const f = fixture(t);
  const expected = structuredClone(f.state);
  delete f.state["/usr/local/sbin/usine-gateway-install"];
  const result = f.run();
  success(result);
  assert.deepEqual(result.state, expected);
  assert.equal(writes(result).length, 1);
  assert.deepEqual(reloads(result), []);
});

test("a failed copy stops later copies and all reloads", (t) => {
  const f = fixture(t);
  stale(f.state, "/etc/nftables.conf");
  stale(f.state, "/etc/usine-gateway/settings.env");
  const result = f.run([], { SSH_FAIL: "set -eu" });
  assert.equal(result.status, 1);
  assert.deepEqual(result.state, f.state);
  assert.equal(writes(result).length, 1);
  assert.deepEqual(reloads(result), []);
  assert.match(result.stderr, /Apply stopped/);
});

test("rejects unsupported cloud-init file behavior before contacting the gateway", (t) => {
  const f = fixture(t, (document) => {
    document.write_files[0].append = true;
  });
  const result = f.run();
  assert.equal(result.status, 1);
  assert.deepEqual(result.calls, []);
  assert.match(result.stderr, /append/);
});

test("rejects unknown CLI arguments before contacting the gateway", (t) => {
  const f = fixture(t);
  const result = f.run(["--force"]);
  assert.equal(result.status, 2);
  assert.deepEqual(result.calls, []);
  assert.match(result.stderr, /apply takes/);
});

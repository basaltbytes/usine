import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Exit, Runtime, Schema } from "effect";
import { assert, describe, it } from "vitest";
import { parse } from "yaml";
import { DEFAULT_PORT } from "../src/cli.ts";

// turbo.json lists these files as inputs of this package's tests.
const infra = (path: string) => fileURLToPath(new URL(`../../../infra/${path}`, import.meta.url));
const read = (path: string) => readFileSync(infra(path), "utf8");

const UserData = Schema.Struct({
  users: Schema.Array(
    Schema.Struct({ name: Schema.String, ssh_authorized_keys: Schema.Array(Schema.String) }),
  ),
  packages: Schema.Array(Schema.String),
  write_files: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      content: Schema.String,
      encoding: Schema.optionalKey(Schema.Literal("b64")),
    }),
  ),
  runcmd: Schema.Array(Schema.Array(Schema.String)),
});

const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOrchestratorShapeCheck operator";

/** Renders the orchestrator's user data as `gateway.sh orchestrator-user-data` sends it. */
const rendered = () => {
  const folder = mkdtempSync(join(tmpdir(), "usine-orchestrator-"));
  try {
    writeFileSync(join(folder, "keys.pub"), `${KEY}\n`);
    return execFileSync(
      "sh",
      [infra("hetzner/gateway/gateway.sh"), "orchestrator-user-data", join(folder, "keys.pub")],
      { encoding: "utf8" },
    );
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
};

const fileOf = (userData: typeof UserData.Type, path: string) => {
  const file = userData.write_files.find((entry) => entry.path === path);
  assert(file !== undefined, `the user data writes ${path}`);
  return file.encoding === "b64"
    ? Buffer.from(file.content, "base64").toString("utf8")
    : file.content;
};

/** The exit status of a `usine up` that its first `SIGTERM` stopped, from Effect's runtime. */
const interruptedStatus = () => {
  let status = 0;
  Runtime.defaultTeardown(Exit.interrupt(), (code) => {
    status = code;
  });
  return status;
};

describe("the orchestrator's Hetzner server", () => {
  const text = rendered();
  const userData = Schema.decodeUnknownSync(UserData)(parse(text));

  it("renders a cloud-config with the usine user's keys, the attempt image's Node.js, and the gateway's settings", () => {
    assert.strictEqual(text.split("\n")[0], "#cloud-config");
    assert.deepStrictEqual(
      userData.users.map(({ name, ssh_authorized_keys }) => [name, ssh_authorized_keys]),
      [["usine", [KEY]]],
    );
    assert.deepStrictEqual(
      text
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("#") && /@{1,2}[A-Z_0-9]+@/u.test(line)),
      [],
      "every placeholder outside a comment is replaced",
    );
    const nodeMajors = [...text.matchAll(/deb\.nodesource\.com\/node_(\S+)\.x/gu)].map(
      ([, major]) => major,
    );
    assert.deepStrictEqual(
      nodeMajors,
      [...read("worker-image/Dockerfile").matchAll(/^ARG NODE_MAJOR=(\S+)$/gmu)].map(
        ([, major]) => major,
      ),
    );
    assert.include(
      fileOf(userData, "/etc/chrony/conf.d/usine-orchestrator.conf"),
      "server 10.42.0.2 ",
    );
    assert.deepStrictEqual(userData.runcmd, [["/usr/local/sbin/usine-orchestrator-setup"]]);
    for (const name of ["chrony", "nftables", "polkitd"]) assert.include(userData.packages, name);
  });

  it("installs Tailscale with the signing key that the gateway pins", () => {
    const gatewayKey = read("hetzner/gateway/gateway-cloud-init.yaml")
      .split("\n")
      .map((line) => line.trim())
      .join("\n")
      .match(
        /-----BEGIN PGP PUBLIC KEY BLOCK-----[\s\S]+?-----END PGP PUBLIC KEY BLOCK-----/u,
      )?.[0];
    assert(gatewayKey !== undefined);
    assert.strictEqual(fileOf(userData, "/etc/apt/keyrings/tailscale.asc").trim(), gatewayKey);
    assert.include(
      fileOf(userData, "/usr/local/sbin/usine-orchestrator-setup"),
      "signed-by=/etc/apt/keyrings/tailscale.asc] https://pkgs.tailscale.com/stable/debian",
    );
  });

  it("loads the orchestrator's nftables ruleset once the server is on the tailnet", () => {
    assert.strictEqual(
      fileOf(userData, "/etc/nftables.conf"),
      read("hetzner/orchestrator-nftables.conf"),
    );
    // The rules refuse SSH through the gateway, the only path to the server before it joins the tailnet.
    assert.notMatch(
      fileOf(userData, "/usr/local/sbin/usine-orchestrator-setup"),
      /^\s*systemctl\b.*\bnftables\b/mu,
    );
    const tailnetUp = read("hetzner/gateway/gateway.sh").match(
      /^orchestrator_tailnet_up\(\) \{\n[\s\S]+?\n\}$/mu,
    )?.[0];
    assert(tailnetUp !== undefined);
    assert.match(
      tailnetUp,
      new RegExp(
        `tailscale_up [^\\n]+--advertise-tags=[\\s\\S]+tailscale serve --bg ${DEFAULT_PORT}\\n[\\s\\S]+systemctl enable --now nftables`,
        "u",
      ),
    );
  });

  it("accepts new connections only from the tailnet, to SSH, and none from the private network", () => {
    const rules = read("hetzner/orchestrator-nftables.conf");
    assert.match(rules, /^flush ruleset$/mu, "a reload replaces every rule");
    assert.match(rules, /chain input \{\n\t+type filter hook input priority filter; policy drop;/u);
    assert.match(
      rules,
      /chain forward \{\n\t+type filter hook forward priority filter; policy drop;/u,
    );
    assert.deepStrictEqual(
      rules
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.endsWith(" accept")),
      [
        "iif lo accept",
        "ct state established,related accept",
        "meta l4proto { icmp, ipv6-icmp } accept",
        'iifname "tailscale0" tcp dport 22 accept',
        "udp sport 67 udp dport 68 accept",
      ],
    );
  });

  it("runs usine up in a systemd service that drains on its stop and treats the drained exit as clean", () => {
    const unit = fileOf(userData, "/etc/systemd/system/usine.service");
    const settings = (key: string) =>
      [...unit.matchAll(new RegExp(`^${key}=(.*)$`, "gmu"))].map(([, value]) => value);
    assert.deepStrictEqual(settings("User"), ["usine"]);
    assert.deepStrictEqual(settings("WorkingDirectory"), ["/home/usine/factory"]);
    assert.deepStrictEqual(settings("ExecStart"), ["/home/usine/.local/bin/usine up"]);
    // SIGTERM to usine up alone: the drain keeps the SSH connections of running attempts.
    assert.deepStrictEqual(settings("KillMode"), ["mixed"]);
    assert.deepStrictEqual(settings("KillSignal"), ["SIGTERM"]);
    assert.deepStrictEqual(settings("Restart"), ["on-failure"]);
    // Otherwise Restart=on-failure would start again a service that usine stop drained.
    assert.deepStrictEqual(settings("SuccessExitStatus"), [String(interruptedStatus())]);
    // usine reads .env with dotenv's syntax, and systemd's values would win over it.
    assert.deepStrictEqual(settings("EnvironmentFile"), []);
    assert.include(
      fileOf(userData, "/etc/polkit-1/rules.d/50-usine.rules"),
      'action.lookup("unit") === "usine.service"',
    );
  });
});

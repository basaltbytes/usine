import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { parse } from "yaml";

const WriteFile = Schema.Struct({
  path: Schema.String,
  content: Schema.String,
  permissions: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^0?[0-7]{3}$/))),
  owner: Schema.optionalKey(
    Schema.String.check(Schema.isPattern(/^[a-z_][a-z0-9_-]*:[a-z_][a-z0-9_-]*$/)),
  ),
  encoding: Schema.optionalKey(Schema.Literals(["text", "b64"])),
});

const reloadsByPath = new Map([
  ["/etc/nftables.conf", ["nft -f /etc/nftables.conf"]],
  ["/etc/usine-gateway/settings.env", ["systemctl restart usine-gateway"]],
  [
    "/etc/systemd/system/usine-gateway.service",
    ["systemctl daemon-reload", "systemctl restart usine-gateway"],
  ],
  ["/etc/dnsmasq.d/usine-gateway.conf", ["systemctl restart dnsmasq"]],
  ["/etc/default/dnsmasq", ["systemctl restart dnsmasq"]],
  ["/etc/chrony/conf.d/usine-gateway.conf", ["systemctl restart chrony"]],
  ["/etc/ssh/sshd_config.d/50-usine-gateway.conf", ["sshd -t && systemctl reload ssh"]],
  ["/etc/sysctl.d/90-usine-gateway.conf", ["sysctl -p /etc/sysctl.d/90-usine-gateway.conf"]],
  ["/etc/apt/keyrings/tailscale.asc", []],
  ["/usr/local/sbin/usine-gateway-install", []],
  ["/usr/local/sbin/usine-gateway-setup", []],
]);

const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const ownedByGateway = (path) =>
  path === "/etc/usine-gateway/egress-allowlist" ||
  path === "/etc/usine-gateway/secrets.env" ||
  path.startsWith("/var/lib/usine-gateway/");

function filesFrom(source) {
  const document = Schema.decodeUnknownSync(Schema.Struct({ write_files: Schema.Unknown }))(
    parse(source),
  );
  const files = Schema.decodeUnknownSync(Schema.Array(WriteFile), { onExcessProperty: "error" })(
    document.write_files,
  );
  const paths = new Set();
  return files.flatMap((file) => {
    if (ownedByGateway(file.path)) {
      console.log(`Skip gateway-owned file: ${file.path}`);
      return [];
    }
    if (!reloadsByPath.has(file.path) || paths.has(file.path)) {
      throw new Error(`Unknown or repeated managed path: ${file.path}`);
    }
    paths.add(file.path);
    const { path, content, permissions = "0644", owner = "root:root", encoding = "text" } = file;
    if (
      encoding === "b64" &&
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(content)
    ) {
      throw new Error(`Invalid base64 content: ${path}`);
    }
    return [
      {
        path,
        owner,
        mode: Number.parseInt(permissions, 8).toString(8),
        content: Buffer.from(content, encoding === "b64" ? "base64" : "utf8"),
      },
    ];
  });
}

function run(command, args, input) {
  const result = spawnSync(command, args, { input, maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    throw new Error(`${command} failed (${result.status ?? result.signal}): ${args.at(-1)}`);
  }
  return result.stdout;
}

function apply(template, mode, destination, identity, script) {
  const files = filesFrom(readFileSync(template, "utf8"));
  const sshArgs = identity
    ? ["-i", identity, "-o", "IdentitiesOnly=yes", destination]
    : [destination];
  const ssh = (command, input) => run("ssh", [...sshArgs, command], input);
  if (ssh("id -u").toString().trim() !== "0") {
    const root = `root@${destination.slice(destination.lastIndexOf("@") + 1)}`;
    const args = [
      script,
      "apply",
      ...(identity ? ["-i", identity] : []),
      ...(mode === "dry-run" ? ["--dry-run"] : []),
    ];
    throw new Error(
      `apply requires root on the gateway. Keep your render variables and run with a root SSH destination:\nGATEWAY_SSH=${quote(root)} ${args.map(quote).join(" ")}`,
    );
  }

  const work = mkdtempSync(join(tmpdir(), "usine-gateway-apply-"));
  try {
    const changed = [];
    for (const file of files) {
      const path = quote(file.path);
      const current = ssh(
        `if [ -e ${path} ]; then stat -c '%a %U:%G' -- ${path} && cat -- ${path}; else printf 'missing\\n'; fi`,
      );
      const separator = current.indexOf(10);
      if (separator === -1) throw new Error(`Missing file metadata: ${file.path}`);
      const metadata = current.subarray(0, separator).toString();
      const content = current.subarray(separator + 1);
      const desired = `${file.mode} ${file.owner}`;
      if (metadata === desired && content.equals(file.content)) continue;
      console.log(`Change ${file.path}: ${metadata} -> ${desired}`);
      writeFileSync(join(work, "current"), content);
      writeFileSync(join(work, "rendered"), file.content);
      const diff = spawnSync("diff", [
        "-u",
        "--label",
        `gateway:${file.path}`,
        "--label",
        `rendered:${file.path}`,
        join(work, "current"),
        join(work, "rendered"),
      ]);
      if (diff.error) throw diff.error;
      if (diff.status !== 0 && diff.status !== 1) throw new Error(`diff failed: ${file.path}`);
      process.stdout.write(diff.stdout);
      changed.push(file);
    }
    if (changed.length === 0) {
      console.log("Gateway configuration is unchanged; no reloads needed.");
      return;
    }

    const reloads = new Set(changed.flatMap((file) => reloadsByPath.get(file.path)));
    const commands = [];
    if (reloads.delete("systemctl daemon-reload")) commands.push("systemctl daemon-reload");
    commands.push(...reloads);
    console.log(
      `Reload commands (run as root on ${destination}):\n${commands.join("\n") || "None"}`,
    );
    if (mode === "dry-run") {
      console.log(
        `Dry run: ${changed.length} changed file(s); no files written or services reloaded.`,
      );
      return;
    }

    try {
      for (const file of changed) {
        const [user, group] = file.owner.split(":");
        const path = quote(file.path);
        ssh(
          `set -eu
path=${path}
mkdir -p -- "$(dirname "$path")"
temporary=$(mktemp "$path.apply.XXXXXX")
trap 'rm -f -- "$temporary"' EXIT
cat > "$temporary"
chown ${quote(user)}:${quote(group)} "$temporary"
chmod ${quote(file.mode)} "$temporary"
mv -f -- "$temporary" "$path"`,
          file.content,
        );
        console.log(`Applied ${file.path}`);
      }
      for (const command of commands) {
        console.log(`Run: ${command}`);
        process.stdout.write(ssh(command));
      }
    } catch (error) {
      console.error(
        "Apply stopped; files already copied remain changed. Resolve the failure, rerun apply for remaining files, then run the reload commands printed above even if the next diff is empty.",
      );
      throw error;
    }
    console.log(`Applied ${changed.length} file(s).`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

try {
  apply(...process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

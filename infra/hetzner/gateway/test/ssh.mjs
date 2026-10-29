#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const command = args.at(-1);
const state = JSON.parse(readFileSync(process.env.SSH_STATE, "utf8"));
appendFileSync(process.env.SSH_LOG, `${JSON.stringify(args)}\n`);
const syntax = spawnSync("sh", ["-n"], { input: command });
if (syntax.status !== 0) {
  process.stderr.write(syntax.stderr);
  process.exit(25);
}
if (process.env.SSH_FAIL && command.includes(process.env.SSH_FAIL)) {
  console.error("SSH fixture failure");
  process.exit(23);
}
if (command === "id -u") {
  console.log(process.env.SSH_UID ?? "0");
} else if (command.startsWith("if [ -e ")) {
  const path = command.match(/^if \[ -e '([^']+)'/)[1];
  const file = state[path];
  if (file) {
    console.log(`${file.mode} ${file.owner}`);
    process.stdout.write(Buffer.from(file.content, "base64"));
  } else {
    console.log("missing");
  }
} else if (command.startsWith("set -eu\npath=")) {
  const path = command.match(/\npath='([^']+)'/)[1];
  const [, user, group] = command.match(/\nchown '([^']+)':'([^']+)'/);
  const mode = command.match(/\nchmod '([^']+)'/)[1];
  state[path] = { owner: `${user}:${group}`, mode, content: readFileSync(0).toString("base64") };
  writeFileSync(process.env.SSH_STATE, JSON.stringify(state));
} else if (!/^(systemctl |nft -f |sshd -t |sysctl -p )/.test(command)) {
  console.error(`Unexpected SSH command: ${command}`);
  process.exit(24);
}

#!/usr/bin/env node
import { Boxd } from "@boxd-sh/sdk";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const [file, worker, ...extra] = process.argv.slice(2);
const token = process.env.BOXD_TOKEN?.trim();

try {
  if (!file || !worker || extra.length > 0)
    throw new Error("Usage: node infra/boxd/link-ssh-key.mjs <public-key.pub> <worker-name>");
  if (!token)
    throw new Error(
      "Set BOXD_TOKEN to a signed-in boxd session token. API keys cannot link SSH keys.",
    );
  const pubkey = (await readFile(file, "utf8")).trim();
  const match = /^\S+[ \t]+([A-Za-z0-9+/]+={0,2})(?:[ \t]+[^\r\n]*)?$/u.exec(pubkey);
  if (!match) throw new Error(`Invalid SSH public key at ${file}`);
  const bytes = Buffer.from(match[1], "base64");
  if (
    bytes.length === 0 ||
    bytes.toString("base64").replace(/=+$/u, "") !== match[1].replace(/=+$/u, "")
  )
    throw new Error(`Invalid SSH public key at ${file}`);
  const fingerprint = `SHA256:${createHash("sha256").update(bytes).digest("base64").replace(/=+$/u, "")}`;
  const boxd = new Boxd({ token, timeout: 30_000, maxRetries: 0 });
  try {
    await boxd.account.linkSshKey({
      pubkey,
      deviceId: `usine:${worker}`,
      label: `usine worker ${worker}`,
    });
  } finally {
    await boxd.close();
  }
  process.stdout.write(`${fingerprint}\n`);
} catch (cause) {
  const message = cause instanceof Error ? cause.message : String(cause);
  process.stderr.write(`${token ? message.replaceAll(token, "[redacted]") : message}\n`);
  process.exitCode = 1;
}

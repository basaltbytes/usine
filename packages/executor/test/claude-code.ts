import { readFileSync } from "node:fs";

const cloudInit = readFileSync(
  new URL("../../../infra/hetzner/cloud-init.yaml", import.meta.url),
  "utf8",
);
const claudeCodeVersion = /@anthropic-ai\/claude-code@(\S+)/u.exec(cloudInit)?.[1];
if (claudeCodeVersion === undefined)
  throw new Error("infra/hetzner/cloud-init.yaml pins no Claude Code version");

/** The `claude --version` output of the Claude Code version that the Hetzner worker image pins. */
export const claudeVersionOutput = `${claudeCodeVersion} (Claude Code)\n`;

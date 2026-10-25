import { describe, expect, it } from "@effect/vitest";
import { readFileSync } from "node:fs";
import { PROVIDER_HOSTS, PROCESSES_DIRECTORY, SANDBOX_HOME } from "../src/api/harness.ts";

// turbo.json lists the cloud-init file as an input of this package's tests.
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const dockerfile = read("../image/Dockerfile");
const npmPins = (source: string) =>
  Object.fromEntries(
    [...source.matchAll(/(pnpm|@anthropic-ai\/claude-code|@openai\/codex)@(\S+)/gu)].map(
      ([, name, version]) => [name, version],
    ),
  );

describe("sandbox image", () => {
  it("installs the harness versions of the Hetzner worker image", () => {
    const pins = npmPins(dockerfile);

    expect(Object.keys(pins)).toHaveLength(3);
    expect(pins).toEqual(npmPins(read("../../../infra/hetzner/cloud-init.yaml")));
  });

  it("points Codex at the OpenAI handler with the placeholder's variable", () => {
    const codex = read("../image/codex-config.toml");

    expect(codex).toContain(`base_url = "http://${PROVIDER_HOSTS.openai.sandbox}/v1"`);
    expect(codex).toContain('env_key = "OPENAI_API_KEY"');
    expect(codex).toMatch(/^model_provider = "usine"$/mu);
  });

  it("creates the home and processes directories that the Worker writes to", () => {
    expect(dockerfile).toContain(`WORKDIR ${SANDBOX_HOME}`);
    expect(dockerfile).toContain(PROCESSES_DIRECTORY);
    expect(dockerfile).toContain(
      `COPY --chown=usine:usine codex-config.toml ${SANDBOX_HOME}/.codex/config.toml`,
    );
  });
});

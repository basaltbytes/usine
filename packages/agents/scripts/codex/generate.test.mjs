import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CODEX_PROTOCOL } from "../../src/protocol/codex/version.ts";

const script = fileURLToPath(new URL("generate.mjs", import.meta.url));
const copy = fileURLToPath(
  new URL("../../src/protocol/codex/upstream-schema.json", import.meta.url),
);

/** Runs the generator with `fetch` replaced by `stub`, a JavaScript function expression. */
const generate = (script, stub, ...args) =>
  spawnSync(
    process.execPath,
    [
      "--disable-warning=ExperimentalWarning",
      "--import",
      `data:text/javascript,${encodeURIComponent(`import { readFileSync } from "node:fs";globalThis.fetch = ${stub};`)}`,
      "--experimental-strip-types",
      script,
      ...args,
    ],
    { encoding: "utf8", timeout: 60_000 },
  );

const unreachable = `async () => { throw new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND raw.githubusercontent.com") }); }`;

const copyPackage = (onTestFinished) => {
  const root = mkdtempSync(join(tmpdir(), "codex-generator-"));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const pkg = join(root, "packages/agents");
  cpSync(new URL("../../scripts", import.meta.url), join(pkg, "scripts"), { recursive: true });
  cpSync(new URL("../../src/protocol/codex", import.meta.url), join(pkg, "src/protocol/codex"), {
    recursive: true,
  });
  cpSync(new URL("../../package.json", import.meta.url), join(pkg, "package.json"));
  cpSync(new URL("../../../../.oxfmtrc.json", import.meta.url), join(root, ".oxfmtrc.json"));
  symlinkSync(
    fileURLToPath(new URL("../../node_modules", import.meta.url)),
    join(pkg, "node_modules"),
    "dir",
  );
  return {
    script: join(pkg, "scripts/codex/generate.mjs"),
    copy: join(pkg, "src/protocol/codex/upstream-schema.json"),
    output: join(pkg, "src/protocol/codex/generated.ts"),
  };
};

describe("codex generator", () => {
  it("checks the generated schemas against the local copy without fetching", () => {
    const result = generate(script, unreachable, "--check");
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  }, 60_000);

  it("reports an unreachable upstream in one line after checking the local copy", () => {
    const result = generate(script, unreachable, "--check", "--upstream");
    expect(result.stderr).toBe(
      "upstream fetch failed: getaddrinfo ENOTFOUND raw.githubusercontent.com; the local copy was checked\n",
    );
    expect(result.status).toBe(2);
  }, 60_000);

  it("reports an HTTP failure from upstream in one line", () => {
    const result = generate(
      script,
      `async () => new Response("", { status: 403, statusText: "Forbidden" })`,
      "--check",
      "--upstream",
    );
    expect(result.stderr).toBe(
      "upstream fetch failed: HTTP 403 Forbidden; the local copy was checked\n",
    );
    expect(result.status).toBe(2);
  }, 60_000);

  it("names the local copy and the pinned upstream file when they differ", () => {
    const result = generate(
      script,
      `async () => new Response(readFileSync(${JSON.stringify(copy)}, "utf8") + "\\n")`,
      "--check",
      "--upstream",
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `src/protocol/codex/upstream-schema.json does not match https://raw.githubusercontent.com/openai/codex/${CODEX_PROTOCOL.commit}/`,
    );
  }, 60_000);

  it("accepts a local copy identical to the pinned upstream file", () => {
    const result = generate(
      script,
      `async () => new Response(readFileSync(${JSON.stringify(copy)}, "utf8"))`,
      "--check",
      "--upstream",
    );
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  }, 60_000);

  it("replaces the local copy and regenerates from the fetched schema", ({ onTestFinished }) => {
    const fixture = copyPackage(onTestFinished);
    const previous = readFileSync(fixture.output, "utf8");
    const updated = JSON.parse(readFileSync(copy, "utf8"));
    updated.definitions.v2.AgentMessageDeltaNotification.properties.updateMarker = {
      type: "string",
    };
    const upstream = JSON.stringify(updated);
    const fetched = `${fixture.copy}.fetched`;
    writeFileSync(fetched, upstream);
    const result = generate(
      fixture.script,
      `async () => new Response(readFileSync(${JSON.stringify(fetched)}, "utf8"))`,
      "--upstream",
    );
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(readFileSync(fixture.copy, "utf8")).toBe(upstream);
    const generated = readFileSync(fixture.output, "utf8");
    expect(generated).not.toBe(previous);
    expect(generated).toContain("updateMarker: Schema.optionalKey(Schema.String)");
    const checked = generate(fixture.script, unreachable, "--check");
    expect(checked.stderr).toBe("");
    expect(checked.status).toBe(0);
  }, 60_000);

  it("leaves both files unchanged when an update cannot fetch upstream", ({ onTestFinished }) => {
    const fixture = copyPackage(onTestFinished);
    writeFileSync(fixture.output, "// Stale generated output\n");
    const previousCopy = readFileSync(fixture.copy);
    const previousOutput = readFileSync(fixture.output);
    const result = generate(fixture.script, unreachable, "--upstream");
    expect(result.stderr).toBe(
      "upstream fetch failed: getaddrinfo ENOTFOUND raw.githubusercontent.com; nothing was written\n",
    );
    expect(result.status).toBe(2);
    expect(readFileSync(fixture.copy)).toEqual(previousCopy);
    expect(readFileSync(fixture.output)).toEqual(previousOutput);
  }, 60_000);

  it("bounds the upstream fetch and reports a timeout in one line", () => {
    const result = generate(
      script,
      `async (_url, options) => {
        if (!(options?.signal instanceof AbortSignal)) throw new Error("Missing timeout signal");
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      }`,
      "--check",
      "--upstream",
    );
    expect(result.stderr).toBe(
      "upstream fetch failed: The operation was aborted due to timeout; the local copy was checked\n",
    );
    expect(result.status).toBe(2);
  }, 60_000);
});

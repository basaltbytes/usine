import { assert, describe, it } from "@effect/vitest";
import { Result } from "effect";
import { parseEgressAllowlist } from "../src/egress/egress.ts";

const allowlist = Result.getOrThrow(
  parseEgressAllowlist(
    [
      "# Package registries",
      "registry.npmjs.org",
      "",
      "*.pythonhosted.org   # wheels",
      "proxy.golang.org:443",
    ].join("\n"),
  ),
);

const verdict = (host: string, port: number) => {
  const decision = allowlist.decide(host, port);
  return decision._tag === "EgressPermitted" ? "permitted" : decision.reason;
};

describe("EgressAllowlist", () => {
  it("permits a listed host on HTTPS and HTTP in any letter case, and a rule with a port only on that port", () => {
    assert.strictEqual(verdict("registry.npmjs.org", 443), "permitted");
    assert.strictEqual(verdict("Registry.NPMJS.org.", 80), "permitted");
    assert.strictEqual(verdict("registry.npmjs.org", 22), "port-not-allowed");
    assert.strictEqual(verdict("proxy.golang.org", 443), "permitted");
    assert.strictEqual(verdict("proxy.golang.org", 80), "port-not-allowed");
  });

  it("a wildcard covers subdomains only, and a lookalike suffix is not a subdomain", () => {
    assert.strictEqual(verdict("files.pythonhosted.org", 443), "permitted");
    assert.strictEqual(verdict("pythonhosted.org", 443), "host-not-allowed");
    assert.strictEqual(verdict("evilpythonhosted.org", 443), "host-not-allowed");
  });
});

import { assert, describe, it } from "@effect/vitest";
import { Result } from "effect";
import { dnsmasqConfiguration } from "../src/egress/dnsmasq.ts";
import { parseEgressAllowlist } from "../src/egress/egress.ts";
import { GatewayDomain } from "../src/settings.ts";

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
  it("permits a listed host on HTTPS and HTTP, in any letter case", () => {
    assert.strictEqual(verdict("registry.npmjs.org", 443), "permitted");
    assert.strictEqual(verdict("Registry.NPMJS.org.", 80), "permitted");
    assert.strictEqual(verdict("registry.npmjs.org", 22), "port-not-allowed");
  });

  it("a wildcard covers subdomains only, and a lookalike suffix is not a subdomain", () => {
    assert.strictEqual(verdict("files.pythonhosted.org", 443), "permitted");
    assert.strictEqual(verdict("pythonhosted.org", 443), "host-not-allowed");
    assert.strictEqual(verdict("evilpythonhosted.org", 443), "host-not-allowed");
  });

  it("a rule with a port permits only that port", () => {
    assert.strictEqual(verdict("proxy.golang.org", 443), "permitted");
    assert.strictEqual(verdict("proxy.golang.org", 80), "port-not-allowed");
  });

  it("refuses unlisted hosts and IP addresses, which no rule can name", () => {
    assert.strictEqual(verdict("github.com", 443), "host-not-allowed");
    assert.strictEqual(verdict("140.82.121.3", 443), "address-literal");
    assert.strictEqual(verdict("::1", 443), "address-literal");
  });

  it("reports the line of an entry it cannot read", () => {
    const parsed = parseEgressAllowlist("registry.npmjs.org\nhttps://pypi.org/simple\n");
    assert(Result.isFailure(parsed));
    assert.strictEqual(parsed.failure.line, 2);
    assert(Result.isFailure(parseEgressAllowlist("10.0.0.2\n")));
    assert(Result.isFailure(parseEgressAllowlist("registry.npmjs.org:70000\n")));
  });
});

describe("dnsmasqConfiguration", () => {
  it("answers exactly the names the allowlist permits on port 443, and no others", () => {
    const withMirror = Result.getOrThrow(
      parseEgressAllowlist(
        ["registry.npmjs.org", "*.pythonhosted.org", "deb.debian.org:80"].join("\n"),
      ),
    );
    // host-record answers one name, where address= would answer every subdomain too; "*." leaves the bare domain out; local= keeps AAAA from being refused.
    assert.deepStrictEqual(
      dnsmasqConfiguration(withMirror, {
        domain: GatewayDomain.make("gw.internal"),
        address: "10.42.0.2",
      }),
      [
        // The reverse lookup of the gateway's address names its domain, not an allowlisted host.
        "host-record=gw.internal,10.42.0.2",
        "host-record=registry.npmjs.org,10.42.0.2",
        "local=/registry.npmjs.org/",
        "address=/*.pythonhosted.org/10.42.0.2",
        "local=/*.pythonhosted.org/",
      ],
    );
  });
});

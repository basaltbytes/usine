import { describe, expect, it } from "@effect/vitest";
import { DateTime, Option, Redacted } from "effect";
import { ApiKeyCredential, ProviderGrant, SandboxCredentials } from "../src/api/api.ts";
import { harnessEnvironment, PROVIDER_HOSTS } from "../src/api/harness.ts";
import {
  allowedHostsOf,
  gitHubRequest,
  interceptionsFor,
  providerRequest,
} from "../src/sandbox/outbound.ts";

const issuedAt = DateTime.makeUnsafe("2026-10-26T08:00:00.000Z");

const credentials = new SandboxCredentials({
  issuedAt,
  github: Option.some(Redacted.make("ghs_installation-token")),
  providers: [
    new ProviderGrant({
      provider: "anthropic",
      credential: new ApiKeyCredential({ key: Redacted.make("sk-ant-key") }),
    }),
  ],
});

describe("sandbox outbound handlers", () => {
  it("never lets an allowlisted host bypass the GitHub and provider credentials", () => {
    const interceptions = interceptionsFor(
      credentials,
      allowedHostsOf(" registry.npmjs.org, GitHub.com,api.github.com,,anthropic.usine.internal"),
    );

    expect(interceptions.map(({ _tag, host }) => `${_tag}:${host}`)).toEqual([
      "GitHub:github.com",
      "GitHub:api.github.com",
      "Provider:anthropic.usine.internal",
      "Denied:openai.usine.internal",
      "Allowed:registry.npmjs.org",
    ]);
  });

  it("denies every GitHub and provider host once the credentials are revoked", () => {
    const revoked = interceptionsFor(
      new SandboxCredentials({ issuedAt, github: Option.none(), providers: [] }),
      [],
    );

    expect(revoked.map(({ _tag, host }) => `${_tag}:${host}`)).toEqual([
      "Denied:github.com",
      "Denied:api.github.com",
      "Denied:anthropic.usine.internal",
      "Denied:openai.usine.internal",
    ]);
  });

  it("replaces the sandbox's credential with the installation token for each GitHub host", () => {
    const token = Redacted.make("ghs_installation-token");
    const git = gitHubRequest(
      new Request("https://github.com/acme/demo.git/info/refs?service=git-upload-pack", {
        headers: { authorization: "token usine-placeholder", "user-agent": "git/2.47" },
      }),
      "github.com",
      token,
    );
    const api = gitHubRequest(
      new Request("https://api.github.com/repos/acme/demo", {
        headers: { authorization: "token usine-placeholder" },
      }),
      "api.github.com",
      token,
    );

    expect(git.headers.get("authorization")).toBe(
      `Basic ${btoa("x-access-token:ghs_installation-token")}`,
    );
    expect(git.headers.get("user-agent")).toBe("git/2.47");
    expect(git.url).toBe("https://github.com/acme/demo.git/info/refs?service=git-upload-pack");
    expect(api.headers.get("authorization")).toBe("token ghs_installation-token");
  });

  it("forwards a provider request to its upstream over HTTPS with the API key", async () => {
    const anthropic = Option.getOrThrow(
      providerRequest(
        new Request(`http://${PROVIDER_HOSTS.anthropic.sandbox}/v1/messages?beta=true`, {
          method: "POST",
          headers: { "x-api-key": "usine-placeholder", "anthropic-version": "2023-06-01" },
          body: '{"model":"claude"}',
        }),
        "anthropic",
        new ApiKeyCredential({ key: Redacted.make("sk-ant-key") }),
      ),
    );
    const openai = Option.getOrThrow(
      providerRequest(
        new Request(`http://${PROVIDER_HOSTS.openai.sandbox}/v1/responses`, {
          method: "POST",
          headers: { authorization: "Bearer usine-placeholder" },
        }),
        "openai",
        new ApiKeyCredential({ key: Redacted.make("sk-openai-key") }),
      ),
    );

    expect(anthropic.url).toBe("https://api.anthropic.com/v1/messages?beta=true");
    expect(anthropic.method).toBe("POST");
    expect(anthropic.headers.get("x-api-key")).toBe("sk-ant-key");
    expect(anthropic.headers.get("anthropic-version")).toBe("2023-06-01");
    expect(await anthropic.text()).toBe('{"model":"claude"}');
    expect(openai.url).toBe("https://api.openai.com/v1/responses");
    expect(openai.headers.get("authorization")).toBe("Bearer sk-openai-key");
  });

  it("adds the API key only to the routes Claude Code and Codex call", () => {
    const key = new ApiKeyCredential({ key: Redacted.make("sk-key") });
    const forward = (provider: "anthropic" | "openai", method: string, path: string) =>
      Option.map(
        providerRequest(
          new Request(`http://${PROVIDER_HOSTS[provider].sandbox}${path}`, { method }),
          provider,
          key,
        ),
        (forwarded) => `${forwarded.method} ${forwarded.url}`,
      );

    expect(forward("anthropic", "GET", "/v1/models/claude-opus-4-5?beta=true")).toEqual(
      Option.some("GET https://api.anthropic.com/v1/models/claude-opus-4-5?beta=true"),
    );
    expect(forward("anthropic", "POST", "/v1/messages/count_tokens")).toEqual(
      Option.some("POST https://api.anthropic.com/v1/messages/count_tokens"),
    );
    expect(forward("openai", "POST", "/v1/responses/compact")).toEqual(
      Option.some("POST https://api.openai.com/v1/responses/compact"),
    );
    const refused = [
      forward("openai", "GET", "/v1/files"),
      forward("openai", "DELETE", "/v1/files/file-abc123"),
      forward("openai", "DELETE", "/v1/models"),
      forward("openai", "GET", "/v1/responses"),
      forward("openai", "POST", "/v1/responses/../files"),
      forward("openai", "POST", "/v1/responses%2F..%2Ffiles"),
      forward("anthropic", "GET", "/v1/files"),
      forward("anthropic", "POST", "/v1/messages/batches"),
      forward("anthropic", "GET", "/v1/organizations/api_keys"),
      forward("anthropic", "DELETE", "/v1/models/claude-opus-4-5"),
      forward("anthropic", "POST", "//attacker.example/v1/messages"),
      forward("anthropic", "POST", "/\\attacker.example/v1/messages"),
    ];
    expect(refused.filter(Option.isSome)).toEqual([]);
  });

  it("never lets a request path choose the host that receives a credential", () => {
    const paths = ["//attacker.example/collect", "/\\attacker.example/collect"];
    for (const path of paths) {
      const git = gitHubRequest(
        new Request(`https://github.com${path}`),
        "github.com",
        Redacted.make("ghs_installation-token"),
      );
      expect(new URL(git.url).host).toBe("github.com");
    }
  });

  it("points only the configured providers' harnesses at their handlers", () => {
    const claudeOnly = harnessEnvironment(["anthropic"]);

    expect(claudeOnly["ANTHROPIC_BASE_URL"]).toBe("http://anthropic.usine.internal");
    expect(claudeOnly["OPENAI_API_KEY"]).toBeUndefined();
    expect(claudeOnly["SSL_CERT_FILE"]).toBe("/etc/cloudflare/certs/cloudflare-containers-ca.crt");
    expect(harnessEnvironment(["openai"])["ANTHROPIC_BASE_URL"]).toBeUndefined();
  });
});

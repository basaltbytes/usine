import { assert, describe, it } from "@effect/vitest";
import { Option } from "effect";
import {
  GITHUB_ORIGINS,
  type GitHubHost,
  gatewayLocation,
  githubRoute,
} from "../src/github/github.ts";

const route = (host: GitHubHost, path: string) => {
  const url = new URL(path, "http://git.gw.test");
  return Option.map(githubRoute(GITHUB_ORIGINS, host, url.pathname, url.search), (found) => ({
    protocol: found.protocol,
    upstream: found.upstream,
    repository: Option.map(found.repository, String),
  }));
};

const upstreamOf = (host: GitHubHost, path: string) =>
  Option.map(route(host, path), ({ upstream, repository }) => [upstream, repository] as const);

describe("githubRoute", () => {
  it("maps git smart HTTP on the gateway host to github.com, with and without .git", () => {
    assert.deepStrictEqual(
      route("gateway", "/acme/demo.git/info/refs?service=git-upload-pack"),
      Option.some({
        protocol: "git" as const,
        upstream: "https://github.com/acme/demo.git/info/refs?service=git-upload-pack",
        repository: Option.some("acme/demo"),
      }),
    );
    assert.deepStrictEqual(
      upstreamOf("gateway", "/acme/demo/git-receive-pack"),
      Option.some([
        "https://github.com/acme/demo/git-receive-pack",
        Option.some("acme/demo"),
      ] as const),
    );
    assert.deepStrictEqual(
      upstreamOf("gateway", "/acme/my.repo.git/info/lfs/objects/batch"),
      Option.some([
        "https://github.com/acme/my.repo.git/info/lfs/objects/batch",
        Option.some("acme/my.repo"),
      ] as const),
    );
  });

  it("does not serve web pages or paths whose repository segment is not a name", () => {
    assert.isTrue(Option.isNone(route("gateway", "/acme/demo")));
    assert.isTrue(Option.isNone(route("gateway", "/acme/demo/settings")));
    assert.isTrue(Option.isNone(route("gateway", "/acme/demo/releases/download/v1.2.0")));
    assert.isTrue(Option.isNone(route("gateway", "/acme/demo/releases/tag/v1.2.0")));
    assert.isTrue(Option.isNone(route("web", "/login")));
    assert.isTrue(Option.isNone(route("gateway", "/api/v3/repos/acme/de%20mo")));
  });
});

describe("gatewayLocation", () => {
  const rewritten = (location: string) =>
    Option.map(gatewayLocation(GITHUB_ORIGINS, "git.gw.test", new URL(location)), String);

  it("leaves hosts other than github.com and api.github.com alone, lookalikes included", () => {
    for (const location of [
      "https://objects.githubusercontent.com/github-production-release-asset-2e65be/1?sig=x",
      "https://uploads.github.com/repos/acme/demo/releases/1/assets",
      "https://codeload.github.com/acme/demo/tar.gz/refs/heads/main",
      "https://github.com.example.net/acme/demo.git/info/refs",
    ])
      assert.isTrue(Option.isNone(rewritten(location)), location);
  });
});

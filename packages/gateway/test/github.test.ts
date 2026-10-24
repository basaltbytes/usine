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

  it("serves the API the way GitHub Enterprise Server does, so gh works with GH_HOST", () => {
    assert.deepStrictEqual(
      route("gateway", "/api/v3/repos/acme/demo/pulls?state=open"),
      Option.some({
        protocol: "api" as const,
        upstream: "https://api.github.com/repos/acme/demo/pulls?state=open",
        repository: Option.some("acme/demo"),
      }),
    );
    assert.deepStrictEqual(
      upstreamOf("gateway", "/api/graphql"),
      Option.some(["https://api.github.com/graphql", Option.none()] as const),
    );
    assert.deepStrictEqual(
      upstreamOf("gateway", "/api/v3/user"),
      Option.some(["https://api.github.com/user", Option.none()] as const),
    );
    assert.deepStrictEqual(
      upstreamOf("gateway", "/api/uploads/repos/acme/demo/releases/1/assets"),
      Option.some([
        "https://uploads.github.com/repos/acme/demo/releases/1/assets",
        Option.some("acme/demo"),
      ] as const),
    );
  });

  it("serves GitHub's own API host for URLs gh follows from responses", () => {
    assert.deepStrictEqual(
      upstreamOf("api", "/repos/acme/demo/actions/artifacts/1/zip"),
      Option.some([
        "https://api.github.com/repos/acme/demo/actions/artifacts/1/zip",
        Option.some("acme/demo"),
      ] as const),
    );
  });

  it("maps release downloads to github.com, tags with a slash and the latest release included", () => {
    for (const path of [
      "/acme/demo/releases/download/v1.2.0/tool.tar.gz",
      "/acme/demo/releases/download/cli/v1.2.0/tool.tar.gz",
      "/acme/demo/releases/latest/download/tool.tar.gz",
    ])
      assert.deepStrictEqual(
        route("gateway", path),
        Option.some({
          protocol: "release" as const,
          upstream: `https://github.com${path}`,
          repository: Option.some("acme/demo"),
        }),
      );
    assert.isTrue(Option.isNone(route("gateway", "/acme/demo/releases/download/v1.2.0")));
    assert.isTrue(Option.isNone(route("gateway", "/acme/demo/releases/tag/v1.2.0")));
  });

  it("does not serve web pages or paths whose repository segment is not a name", () => {
    assert.isTrue(Option.isNone(route("gateway", "/acme/demo")));
    assert.isTrue(Option.isNone(route("gateway", "/acme/demo/settings")));
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

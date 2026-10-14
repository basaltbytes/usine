import { RepositoryName } from "@usine/core/repository";
import { Encoding, Option, Redacted, Schema } from "effect";
import { Headers } from "effect/unstable/http";
import type { AttachmentCredential } from "../attachment/attachment.ts";
import { UpstreamBase } from "../upstream.ts";

/** Where the gateway forwards GitHub requests: `web` serves git smart HTTP, `api` REST and GraphQL, `uploads` release asset uploads. */
export interface GitHubOrigins {
  readonly web: UpstreamBase;
  readonly api: UpstreamBase;
  readonly uploads: UpstreamBase;
}

/** github.com itself. */
export const GITHUB_ORIGINS: GitHubOrigins = {
  web: UpstreamBase.make("https://github.com"),
  api: UpstreamBase.make("https://api.github.com"),
  uploads: UpstreamBase.make("https://uploads.github.com"),
};

/**
 * The host a GitHub request named. `gateway` is `git.<domain>`, which serves
 * git at `/OWNER/REPO.git` and the API under `/api/` the way GitHub
 * Enterprise Server does, so `gh` works with `GH_HOST` set to it. The other
 * three are GitHub's own hosts, which reach the gateway when `gh` sends every
 * request through its `http_unix_socket`, for example when it follows a URL
 * from an API response.
 */
export type GitHubHost = "gateway" | "web" | "api" | "uploads";

/** GitHub's own host names and what each serves. */
export const GITHUB_HOSTS: ReadonlyMap<string, GitHubHost> = new Map([
  ["github.com", "web"],
  ["api.github.com", "api"],
  ["uploads.github.com", "uploads"],
]);

/**
 * A GitHub request the gateway forwards: git smart HTTP for a repository, or
 * an API call. `repository` is the repository the path names; GraphQL and
 * calls such as `/user` name none.
 */
export interface GitHubRoute {
  readonly protocol: "git" | "api";
  readonly upstream: string;
  readonly repository: Option.Option<RepositoryName>;
}

const GIT_PATH =
  /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/(?:info\/refs|git-upload-pack|git-receive-pack|info\/lfs(?:\/[^?#]*)?)$/u;

const REPOSITORY_PATH = /^\/repos\/([^/]+)\/([^/]+)(?:\/|$)/u;

const decodeRepository = Schema.decodeUnknownOption(RepositoryName);

const gitRoute = (origins: GitHubOrigins, pathname: string, search: string) => {
  const match = GIT_PATH.exec(pathname);
  if (match === null) return Option.none();
  return Option.map(decodeRepository(`${match[1]}/${match[2]}`), (repository): GitHubRoute => ({
    protocol: "git",
    upstream: `${origins.web}${pathname}${search}`,
    repository: Option.some(repository),
  }));
};

/** An API route; a `/repos/OWNER/REPO` path whose segments are not a repository name is unsupported. */
const apiRoute = (base: UpstreamBase, rest: string, search: string): Option.Option<GitHubRoute> => {
  const path = rest === "" ? "/" : rest;
  const match = REPOSITORY_PATH.exec(path);
  const repository =
    match === null
      ? Option.some(Option.none())
      : Option.map(decodeRepository(`${match[1]}/${match[2]}`), Option.some);
  return Option.map(repository, (named) => ({
    protocol: "api",
    upstream: `${base}${path}${search}`,
    repository: named,
  }));
};

const afterPrefix = (pathname: string, prefix: string): Option.Option<string> =>
  pathname === prefix || pathname.startsWith(`${prefix}/`)
    ? Option.some(pathname.slice(prefix.length))
    : Option.none();

/**
 * Maps a GitHub request to its upstream URL and the repository it names.
 * `none` means the gateway does not serve that path: web pages, and anything
 * else outside git smart HTTP, Git LFS, and the API.
 */
export const githubRoute = (
  origins: GitHubOrigins,
  host: GitHubHost,
  pathname: string,
  search: string,
): Option.Option<GitHubRoute> => {
  switch (host) {
    case "web":
      return gitRoute(origins, pathname, search);
    case "api":
      return apiRoute(origins.api, pathname, search);
    case "uploads":
      return apiRoute(origins.uploads, pathname, search);
    case "gateway": {
      if (pathname === "/api/graphql") return apiRoute(origins.api, "/graphql", search);
      const rest = afterPrefix(pathname, "/api/v3");
      if (Option.isSome(rest)) return apiRoute(origins.api, rest.value, search);
      const upload = afterPrefix(pathname, "/api/uploads");
      if (Option.isSome(upload)) return apiRoute(origins.uploads, upload.value, search);
      return gitRoute(origins, pathname, search);
    }
  }
};

/**
 * Adds an attachment's credential to a GitHub request whose caller
 * credential has already been removed. git authenticates with the token as
 * the `x-access-token` password; the API takes it as a bearer token. An
 * anonymous attachment adds nothing.
 */
export const withGitHubCredential = (
  route: GitHubRoute,
  credential: AttachmentCredential,
  headers: Headers.Headers,
): Headers.Headers => {
  switch (credential._tag) {
    case "AnonymousCredential":
      return headers;
    case "InstallationCredential": {
      const token = Redacted.value(credential.token);
      return Headers.set(
        headers,
        "authorization",
        route.protocol === "git"
          ? `Basic ${Encoding.encodeBase64(`x-access-token:${token}`)}`
          : `Bearer ${token}`,
      );
    }
  }
};

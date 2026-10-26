import { RepositoryName } from "@usine/core/repository";
import { Option, Schema } from "effect";
import { afterPrefix, type GitHubOrigins } from "./github.ts";

/** The statuses GitHub uses to redirect a renamed or transferred repository's former name. */
export const PERMANENT_REDIRECTS: ReadonlySet<number> = new Set([301, 308]);

/**
 * A URL for the repository itself: git's ref discovery, which starts every clone and fetch, or
 * the API's repository resource.
 */
type RepositoryResource = "git-refs" | "api-repository";

const GIT_REFS_PATH = /^\/([^/]+)\/([^/]+?)(?:\.git)?\/info\/refs$/u;

const API_REPOSITORY_PATH = /^\/repos\/([^/]+)\/([^/]+)$/u;

const decodeRepository = Schema.decodeUnknownOption(RepositoryName);

const repositoryItself = (origins: GitHubOrigins, url: URL) => {
  const target = `${url.origin}${url.pathname}`;
  const named = (resource: RepositoryResource, pattern: RegExp) => (path: string) => {
    const match = pattern.exec(path);
    return match === null
      ? Option.none()
      : Option.map(decodeRepository(`${match[1]}/${match[2]}`), (repository) => ({
          resource,
          repository,
        }));
  };
  return Option.flatMap(afterPrefix(target, origins.web), named("git-refs", GIT_REFS_PATH)).pipe(
    Option.orElse(() =>
      Option.flatMap(
        afterPrefix(target, origins.api),
        named("api-repository", API_REPOSITORY_PATH),
      ),
    ),
  );
};

/**
 * Returns the repository name in `location`, GitHub's redirect of the upstream URL `requested`,
 * if both are git's `/OWNER/REPO/info/refs` or both are the API's `/repos/OWNER/REPO`, so only
 * the owner and repository differ. Returns `None` for other redirects, such as a release
 * download's, which can point at another repository without a rename.
 */
export const redirectedName = (
  origins: GitHubOrigins,
  requested: URL,
  location: URL,
): Option.Option<RepositoryName> =>
  Option.flatMap(repositoryItself(origins, requested), ({ resource }) =>
    repositoryItself(origins, location).pipe(
      Option.filter((redirected) => redirected.resource === resource),
      Option.map(({ repository }) => repository),
    ),
  );

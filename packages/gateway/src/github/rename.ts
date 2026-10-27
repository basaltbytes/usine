import { canonicalRepositoryName, RepositoryName } from "@usine/core/repository";
import { Effect, Option, Schema } from "effect";
import { Headers, HttpClient, HttpClientRequest } from "effect/http";
import type { Attachment } from "../attachment/attachment.ts";
import { absoluteUrl, afterPrefix, type GitHubOrigins, withGitHubCredential } from "./github.ts";

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

/** Why GitHub's API didn't confirm that the attached repository has a redirect's name. */
class RenameUnconfirmed extends Schema.TaggedError<RenameUnconfirmed>()("RenameUnconfirmed", {
  reason: Schema.Literals([
    "former-name-not-redirected",
    "repository-unreadable",
    "other-current-name",
    "github-unreachable",
  ]),
  detail: Schema.String,
}) {}

/** Where GitHub's API redirects a renamed or transferred repository's former name. */
const REPOSITORY_BY_ID_PATH = /^\/repositories\/[1-9][0-9]*$/u;

const decodeCurrentName = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ full_name: RepositoryName })),
);

const API_HEADERS = Headers.fromInput({
  accept: "application/vnd.github+json",
  "user-agent": "usine-gateway",
});

/**
 * Confirms with GitHub's API, using the attachment's credential, that `newName` is the attached
 * repository's current name: `/repos/OWNER/REPO` for the attached name must answer a permanent
 * redirect to `/repositories/ID`, and the `full_name` of repository ID must be `newName`. Fails
 * with `RenameUnconfirmed` otherwise, or if GitHub can't be reached.
 */
export const confirmRename = Effect.fn("GitHubRename.confirm")(function* (
  client: HttpClient.HttpClient,
  origins: GitHubOrigins,
  attachment: Attachment,
  newName: RepositoryName,
) {
  yield* Effect.annotateCurrentSpan({ attachment: attachment.id, newName });
  const get = (url: string) =>
    client
      .execute(
        HttpClientRequest.get(url).pipe(
          HttpClientRequest.setHeaders(
            withGitHubCredential("api", attachment.credential, API_HEADERS),
          ),
        ),
      )
      .pipe(
        Effect.flatMap((response) =>
          Effect.map(response.text, (body) => ({
            status: response.status,
            location: Headers.get(response.headers, "location"),
            body,
          })),
        ),
        Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
        Effect.mapError(
          (error) =>
            new RenameUnconfirmed({ reason: "github-unreachable", detail: error.reason._tag }),
        ),
      );
  const former = yield* get(`${origins.api}/repos/${attachment.repository}`);
  const byId = Option.flatMap(former.location, (location) =>
    Option.flatMap(absoluteUrl(location), (url) =>
      afterPrefix(`${url.origin}${url.pathname}`, origins.api),
    ),
  ).pipe(Option.filter((path) => REPOSITORY_BY_ID_PATH.test(path)));
  if (!PERMANENT_REDIRECTS.has(former.status) || Option.isNone(byId))
    return yield* new RenameUnconfirmed({
      reason: "former-name-not-redirected",
      detail: `/repos/${attachment.repository} answered ${String(former.status)}`,
    });
  const current = yield* get(`${origins.api}${byId.value}`);
  const name = current.status === 200 ? decodeCurrentName(current.body) : Option.none();
  if (Option.isNone(name))
    return yield* new RenameUnconfirmed({
      reason: "repository-unreadable",
      detail: `${byId.value} answered ${String(current.status)}`,
    });
  if (canonicalRepositoryName(name.value.full_name) !== canonicalRepositoryName(newName))
    return yield* new RenameUnconfirmed({
      reason: "other-current-name",
      detail: `${byId.value} is ${name.value.full_name}`,
    });
});

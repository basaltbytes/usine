import type { LoopPermissions } from "@usine/core/loop";
import { RepositoryName } from "@usine/core/repository";
import { Schema } from "effect";
import { InstallationId, RepositoryId, Installation } from "./installation.ts";

/** Repository grants required for polling, label updates, and agent-authored changes. */
export const REQUIRED_REPOSITORY_PERMISSIONS = {
  checks: "read",
  contents: "write",
  issues: "write",
  metadata: "read",
  pull_requests: "write",
} as const;

export type RequiredRepositoryPermission = keyof typeof REQUIRED_REPOSITORY_PERMISSIONS;

/**
 * The repository permissions of an Attempt's token for each Loop permission
 * level (ADR 0011). A `read` token can read the code and still post reviews
 * and comments (`pull_requests` and `issues` stay `write`), but cannot push,
 * merge, or update a branch, which all need `contents: write`. Names and
 * levels are those of the installation token API:
 * https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps
 */
export const WORKER_TOKEN_PERMISSIONS = {
  write: {
    checks: "read",
    contents: "write",
    issues: "write",
    metadata: "read",
    pull_requests: "write",
  },
  read: {
    checks: "read",
    contents: "read",
    issues: "write",
    metadata: "read",
    pull_requests: "write",
  },
} as const satisfies Record<
  LoopPermissions,
  Readonly<Record<RequiredRepositoryPermission, "read" | "write">>
>;

const grants = (actual: string | undefined, required: "read" | "write"): boolean =>
  actual === required || (required === "read" && actual === "write");

/** The required repository permissions an installation grant does not satisfy, as `name:level` strings. */
export const missingPermissions = (
  granted: Readonly<Record<string, string>>,
): ReadonlyArray<string> =>
  Object.entries(REQUIRED_REPOSITORY_PERMISSIONS).flatMap(([permission, required]) =>
    grants(granted[permission], required) ? [] : [`${permission}:${required}`],
  );

/** A registered repository covered by the discovered GitHub App installation. */
export class CoveredProject extends Schema.TaggedClass<CoveredProject>(
  "@usine/github/ProjectAccess/CoveredProject",
)("CoveredProject", {
  installationId: InstallationId,
  repository: RepositoryName,
  repositoryId: RepositoryId,
}) {}

/** A registry repository the installation does not cover. Raised per project, so covered siblings still load. */
export class ProjectNotInstalledError extends Schema.TaggedError<ProjectNotInstalledError>(
  "@usine/github/ProjectNotInstalledError",
)("ProjectNotInstalledError", {
  repository: RepositoryName,
  message: Schema.NonEmptyString,
}) {}

/** The installation coverage result for one registered repository. */
export const ProjectAccess = Schema.Union([CoveredProject, ProjectNotInstalledError]);
export type ProjectAccess = typeof ProjectAccess.Type;

/** A repository reported by GitHub for an installation, identified by its numeric id and full name. */
export interface InstalledRepository {
  readonly id: RepositoryId;
  readonly name: RepositoryName;
}

/** Checks each registry repository against the installation's repositories and returns one `ProjectAccess` per project. */
export const deriveProjectAccess = (
  installation: Installation,
  registry: ReadonlyArray<RepositoryName>,
  installed: ReadonlyArray<InstalledRepository>,
): ReadonlyArray<ProjectAccess> => {
  const byName = new Map(installed.map((repo) => [repo.name.toLowerCase(), repo]));
  return registry.map((repository) => {
    const match = byName.get(repository.toLowerCase());
    return match === undefined
      ? new ProjectNotInstalledError({
          repository,
          message: `The GitHub App installation does not cover ${repository}`,
        })
      : new CoveredProject({
          installationId: installation.id,
          repository,
          repositoryId: match.id,
        });
  });
};

/** The installation lacks required repository grants; missing entries use name:level form. */
export class AppPermissionError extends Schema.TaggedError<AppPermissionError>(
  "@usine/github/AppPermissionError",
)("AppPermissionError", {
  missing: Schema.Array(Schema.NonEmptyString).check(Schema.isNonEmpty()),
  message: Schema.NonEmptyString,
}) {}

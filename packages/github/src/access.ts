import type { LoopPermissions } from "@usine/core/loop";
import { RepositoryName } from "@usine/core/repository";
import { Schema } from "effect";
import { InstallationId, RepositoryId, Installation } from "./installation.ts";

/** The repository permissions required for polling, label updates, and agent-authored changes. */
export const REQUIRED_REPOSITORY_PERMISSIONS = {
  checks: "read",
  contents: "write",
  issues: "write",
  metadata: "read",
  pull_requests: "write",
} as const;

export type RequiredRepositoryPermission = keyof typeof REQUIRED_REPOSITORY_PERMISSIONS;

/**
 * The repository permissions of an Attempt's token for each Loop permission level (ADR 0011).
 * A `read` token can read code and post reviews and comments (`pull_requests` and `issues` are
 * `write`), but can't push, merge, or update a branch, which need `contents: write`. Names and
 * levels follow the installation token API:
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

/** Returns the required repository permissions that `granted` doesn't satisfy, as `name:level` strings. */
export const missingPermissions = (
  granted: Readonly<Record<string, string>>,
): ReadonlyArray<string> =>
  Object.entries(REQUIRED_REPOSITORY_PERMISSIONS).flatMap(([permission, required]) =>
    grants(granted[permission], required) ? [] : [`${permission}:${required}`],
  );

/** A registered repository covered by the GitHub App installation. */
export class CoveredProject extends Schema.TaggedClass<CoveredProject>(
  "@usine/github/ProjectAccess/CoveredProject",
)("CoveredProject", {
  installationId: InstallationId,
  repository: RepositoryName,
  repositoryId: RepositoryId,
}) {}

/** The error for a registry repository the installation doesn't cover. Reported per project, so covered projects still load. */
export class ProjectNotInstalledError extends Schema.TaggedError<ProjectNotInstalledError>(
  "@usine/github/ProjectNotInstalledError",
)("ProjectNotInstalledError", {
  repository: RepositoryName,
  message: Schema.NonEmptyString,
}) {}

/** The installation coverage of one registered repository. */
export const ProjectAccess = Schema.Union([CoveredProject, ProjectNotInstalledError]);
export type ProjectAccess = typeof ProjectAccess.Type;

export interface InstalledRepository {
  readonly id: RepositoryId;
  readonly name: RepositoryName;
}

/** Returns one `ProjectAccess` per registry repository by checking it against the installation's repositories. */
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
          message: `The GitHub App installation has no access to "${repository}"`,
        })
      : new CoveredProject({
          installationId: installation.id,
          repository,
          repositoryId: match.id,
        });
  });
};

/** The error when the installation lacks required repository permissions; `missing` uses `name:level` form. */
export class AppPermissionError extends Schema.TaggedError<AppPermissionError>(
  "@usine/github/AppPermissionError",
)("AppPermissionError", {
  missing: Schema.Array(Schema.NonEmptyString).check(Schema.isNonEmpty()),
  message: Schema.NonEmptyString,
}) {}

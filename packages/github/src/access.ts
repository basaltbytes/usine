import type { LoopPermissions } from "@usine/core/loop";
import { RepositoryName } from "@usine/core/repository";
import { Schema } from "effect";
import { InstallationId, RepositoryId, Installation } from "./installation.ts";

/** The repository permissions required for polling, label updates, and agent-authored changes. */
export const REQUIRED_REPOSITORY_PERMISSIONS = {
  /** Reads check runs for pull request selection. */
  checks: "read",
  /** Allows repository reads and agent-authored commits. */
  contents: "write",
  /** Allows issue comments and label updates. */
  issues: "write",
  /** Reads repository metadata; GitHub grants this permission automatically. */
  metadata: "read",
  /** Allows pull request creation, reviews, and updates. */
  pull_requests: "write",
} as const;

/** A repository permission that the App installation must grant at the required level. */
export type RequiredRepositoryPermission = keyof typeof REQUIRED_REPOSITORY_PERMISSIONS;

/**
 * The repository permissions of an attempt's token for each loop permission level (ADR 0011).
 * A `read` token can read code and post reviews and comments (`pull_requests` and `issues` are
 * `write`), but can't push, merge, or update a branch, which need `contents: write`. Names and
 * levels follow the installation token API:
 * https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps
 */
export const WORKER_TOKEN_PERMISSIONS = {
  /** Allows code changes and item writes for an attempt. */
  write: {
    /** Reads check runs for the attempt. */
    checks: "read",
    /** Allows code reads and pushes. */
    contents: "write",
    /** Allows issue comments and label updates. */
    issues: "write",
    /** Reads repository metadata. */
    metadata: "read",
    /** Allows pull request comments, reviews, and updates. */
    pull_requests: "write",
  },
  /** Allows code reads and item writes, including reviews and comments; code pushes require write access. */
  read: {
    /** Reads check runs for the attempt. */
    checks: "read",
    /** Allows code reads; GitHub refuses pushes and branch updates. */
    contents: "read",
    /** Allows issue comments and label updates. */
    issues: "write",
    /** Reads repository metadata. */
    metadata: "read",
    /** Allows pull request comments, reviews, and updates. */
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
  /** The installation that can mint a token for this repository. */
  installationId: InstallationId,
  /** The managed repository name as supplied in the registry. */
  repository: RepositoryName,
  /** The GitHub repository ID used to restrict a worker token to this repository. */
  repositoryId: RepositoryId,
}) {}

/** The error for a registry repository the installation doesn't cover. Returned per repository, so covered repositories can still run. */
export class ProjectNotInstalledError extends Schema.TaggedError<ProjectNotInstalledError>(
  "@usine/github/ProjectNotInstalledError",
)("ProjectNotInstalledError", {
  /** The registry repository missing from the installation. */
  repository: RepositoryName,
  /** An operator-facing explanation of the missing repository access. */
  message: Schema.NonEmptyString,
}) {}

/** The installation coverage of one registered repository. */
export const ProjectAccess = Schema.Union([CoveredProject, ProjectNotInstalledError]);
export type ProjectAccess = typeof ProjectAccess.Type;

/** A repository accessible to the installation, identified by GitHub's numeric ID and owner/name. */
export interface InstalledRepository {
  /** The repository ID returned by the installation repositories API. */
  readonly id: RepositoryId;
  /** The owner/name returned by GitHub; coverage matching ignores case. */
  readonly name: RepositoryName;
}

/**
 * Returns one coverage result per entry in `registry`, preserving its order and spelling.
 * Matches names against `installed` without case sensitivity and uses `installation.id` for
 * covered repositories. Missing repositories produce individual `ProjectNotInstalledError`
 * values, so callers can continue with covered repositories (ADR 0011).
 */
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
  /** Unsatisfied repository permissions as `name:level` strings; a write grant satisfies a read requirement. */
  missing: Schema.Array(Schema.NonEmptyString).check(Schema.isNonEmpty()),
  /** An operator-facing explanation of the grants needed on the App and installation. */
  message: Schema.NonEmptyString,
}) {}

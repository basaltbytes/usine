import { AppSlug, GitHubApp, Installation, InstallationId } from "@usine/github/github-app";
import { Effect, Layer } from "effect";

/**
 * A `GitHubApp` for the App `usine-test` with bot `usine-test[bot]`, for compositions that only
 * read the installation.
 */
export const testAppLayer = Layer.succeed(GitHubApp)({
  installation: () =>
    Effect.succeed(
      new Installation({
        id: InstallationId.make(1),
        accountLogin: "acme",
        appSlug: AppSlug.make("usine-test"),
      }),
    ),
  installationToken: () => Effect.die("the test App mints no installation token"),
  projectAccess: () => Effect.die("the test App reads no project access"),
  workerToken: () => Effect.die("the test App mints no worker token"),
});

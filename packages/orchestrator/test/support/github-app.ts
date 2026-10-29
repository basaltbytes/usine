import { BotAccount, BotLogin, BotUserId } from "@usine/core/worker";
import {
  AppCredentials,
  AppId,
  AppSlug,
  GitHubApp,
  GitHubCredentials,
  Installation,
  InstallationId,
  PrivateKey,
} from "@usine/github/github-app";
import { Effect, Layer, Redacted } from "effect";

/** The bot account of the test App `usine-test`. */
export const testBotAccount = new BotAccount({
  login: BotLogin.make("usine-test[bot]"),
  id: BotUserId.make(4242),
});

/**
 * A `GitHubApp` for the App `usine-test` with bot `usine-test[bot]`, for compositions that only
 * read the installation and the bot account.
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
  botAccount: () => Effect.succeed(testBotAccount),
  repositories: () => Effect.die("unused installation repositories"),
  installationToken: () => Effect.die("the test App mints no installation token"),
  projectAccess: () => Effect.die("the test App reads no project access"),
  deliveries: () => Effect.die("unused webhook deliveries"),
  workerToken: () => Effect.die("the test App mints no worker token"),
});

/** The credentials of the test App, whose key signs nothing. */
export const testCredentialsLayer = Layer.succeed(
  GitHubCredentials,
  new AppCredentials({
    appId: AppId.make(4242),
    privateKey: Redacted.make(
      PrivateKey.make("-----BEGIN PRIVATE KEY-----\nunused\n-----END PRIVATE KEY-----\n"),
    ),
  }),
);

export const title = "Set up usine";
export const steps = {
  NoApp: {
    title: "Create your GitHub App",
    description:
      "No App credentials were found. Create an App for this instance so usine can work on your repositories.",
  },
  MissingKey: {
    title: "Recover your GitHub App",
    description:
      "App setup was started, but usable credentials are missing. Restore the App credentials below, or create another App.",
  },
  NeedsInstallation: {
    title: "Install your GitHub App",
    description:
      "The App credentials are saved. Install the App on one account and select the repositories usine can access. Return here when GitHub finishes.",
  },
  Repositories: {
    title: "Choose your repositories",
    description:
      "The App installation is connected. Add repositories from its installation to the registry, then create a project.",
  },
  Ready: {
    title: "Your instance is connected",
    description: "Your GitHub App, sign-in, and registry are ready.",
  },
};
export const appName = "App name";
export const organizationLabel = "Organization (optional)";
export const organizationHint = "Leave this blank to create the App on your personal account.";
export const createApp = "Create App on GitHub";
export const creatingApp = "Opening GitHub…";
export const restoreTitle = "I already have an App";
export const restoreHelp =
  "Open your App settings on GitHub to generate a private key and find its App ID, client ID, and client secret. Restore your credential JSON here. Include client_id and client_secret to enable GitHub sign-in.";
export const credentialsLabel = "Credential JSON";
export const restore = "Save credentials";
export const saving = "Saving…";
export const install = "Install App on GitHub";
export const recheck = "Check installation";
export const checking = "Checking…";
export const signInHelp =
  "Sign in through this App to become the instance’s first admin. Your setup session ends after sign-in.";
export const signIn = "Sign in with GitHub";
export const missingSignIn =
  "GitHub sign-in needs the App client ID and secret. Set USINE_GITHUB_CLIENT_ID and USINE_GITHUB_CLIENT_SECRET on the instance, then restart usine.";
export const pickRepositories = "Add repositories";
export const continueToInstance = "Open usine";

export const openingInstance = "Opening usine…";
export const activationFailed = "usine could not start. Check the server log, then try again.";

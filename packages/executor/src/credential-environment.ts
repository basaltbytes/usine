/** The `hosts.yml` that makes gh authenticate to github.com with `token`. */
export const ghHostsConfig = (token: string): string =>
  `github.com:\n    user: x-access-token\n    oauth_token: ${JSON.stringify(token)}\n    git_protocol: https\n    users:\n        x-access-token:\n            oauth_token: ${JSON.stringify(token)}\n`;

/** The `config.yml` gh expects beside `hosts.yml`. */
export const GH_CONFIG = 'version: "1"\n';

/**
 * The variables that give an Attempt's processes its repository credential,
 * kept in `directory` outside its checkout: git asks the credential helper,
 * which reads the `token` file on each authentication, and gh reads the
 * `hosts.yml` in its own `GH_CONFIG_DIR` on each invocation. Renewing the
 * files is enough; no expiring token is frozen in a child's environment.
 */
export const credentialEnvironment = (directory: string) =>
  ({
    GH_CONFIG_DIR: directory,
    GH_PROMPT_DISABLED: "1",
    USINE_GITHUB_TOKEN_FILE: `${directory}/token`,
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "",
    GIT_CONFIG_KEY_1: "credential.helper",
    GIT_CONFIG_VALUE_1:
      '!f() { if [ "$1" = get ]; then echo username=x-access-token; printf "password="; cat "$USINE_GITHUB_TOKEN_FILE"; echo; fi; }; f',
  }) satisfies Record<string, string>;

/** Returns the gh `hosts.yml` content that authenticates github.com with `token`. */
export const ghHostsConfig = (token: string): string =>
  `github.com:\n    user: x-access-token\n    oauth_token: ${JSON.stringify(token)}\n    git_protocol: https\n    users:\n        x-access-token:\n            oauth_token: ${JSON.stringify(token)}\n`;

/** The gh `config.yml` content, required next to `hosts.yml`. */
export const GH_CONFIG = 'version: "1"\n';

/**
 * Returns the environment variables that point git and gh at the credential files in
 * `directory`. git reads `directory/token` and gh reads `directory/hosts.yml` on each use, so
 * renewing the token only requires rewriting those files.
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

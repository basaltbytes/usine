/**
 * The variables of the boxd shell's process environment: the API endpoint of the machine's region
 * and the bearer of its `Exec` calls. They never appear in its arguments, so process listings don't
 * show the credential.
 */
export const BOXD_SHELL_ENVIRONMENT = {
  endpoint: "USINE_BOXD_API_ENDPOINT",
  credential: "USINE_BOXD_CREDENTIAL",
} as const;

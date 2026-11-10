/**
 * The variables of the sandbox shell's process environment: the Worker's origin and the Access
 * service token. They never appear in its arguments, so process listings don't show the token.
 */
export const SHELL_ENVIRONMENT = {
  workerUrl: "USINE_SANDBOX_WORKER_URL",
  accessClientId: "USINE_SANDBOX_ACCESS_CLIENT_ID",
  accessClientSecret: "USINE_SANDBOX_ACCESS_CLIENT_SECRET",
} as const;

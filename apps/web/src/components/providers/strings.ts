import type { LoginProvider, ProviderTarget } from "@usine/gateway/credentials";

export const providersTitle = "Provider connections";
export const providersHelp = "Connect the plans or API keys that your harnesses use.";
/** The name of each subscription login. */
const loginNames = { claude: "Claude", chatgpt: "ChatGPT" } as const satisfies Record<
  LoginProvider,
  string
>;
/** Returns a provider's name: its subscription login's, or its display name without one. */
export const providerName = ({ label, accepts }: ProviderTarget["providers"][number]) =>
  accepts.login === null ? label : loginNames[accepts.login];
export const connect = (name: string) => `Connect ${name}`;
export const replace = (name: string) => `Replace ${name} login`;
export const disconnect = (name: string) => `Disconnect ${name}`;
export const apiKeyChoice = "Use an API key";
export const keyLabel = "API key";
export const saveKey = "Save API key";
export const cancelLogin = "Cancel sign-in";
export const starting = "Starting sign-in…";
export const opening = "Open sign-in page";
export const codeLabel = "Code from Claude";
export const submitCode = "Complete sign-in";
export const pending = "Waiting for authorization…";
export const cancelled = "Sign-in cancelled. You can connect again.";
export const connected = "Connected";
export const disconnected = "Not connected";
export const expires = "Expires";
export const lastRefresh = "Last refresh";
export const unknownTime = "Not reported";
export const tokenExpiryUnknown = "Not included with token";
export const noRefresh = "Not applicable";
export const tokenReplacementHelp =
  "This subscription token cannot refresh automatically. Replace the login before it expires.";
export const keyKind = "API key";
export const subscriptionKind = "Subscription";
export const working = "Saving…";
export const targetLabel = (label: string) => `Credentials stored on ${label}`;

export const refreshProviders = "Check provider connections";

import { catalog } from "@usine/agents/harness";

/**
 * The harness catalog's providers that take an API key: the providers that a worker's API-key
 * variables can name.
 */
export const keyedProviders = catalog.providers.providers.filter((provider) =>
  provider.accepts("api-key"),
);

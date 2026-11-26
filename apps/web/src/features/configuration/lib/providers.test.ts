import { CloudflareLlmProviderKey, ProviderApiKeys } from "@usine/config/factory";
import { Exit, Schema } from "effect";
import { expect, it } from "vitest";
import { keyedProviders } from "./providers";

it("offers only providers that worker configuration accepts an API key for", () => {
  expect(keyedProviders.length).toBeGreaterThan(0);
  for (const { id } of keyedProviders) {
    const key = Schema.decodeExit(CloudflareLlmProviderKey)({ provider: id, apiKeyEnv: "KEY" });
    expect(Exit.isSuccess(key)).toBe(true);
    expect(Exit.isSuccess(Schema.decodeExit(ProviderApiKeys)({ [id]: "KEY" }))).toBe(true);
  }
});

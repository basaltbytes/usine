import { assert, describe, it } from "@effect/vitest";
import { TokenBreakdown } from "@usine/core/agent/session";
import { Option } from "effect";
import { openAiPrice } from "../src/openai-prices.ts";
import { supportedCodexVersions } from "../src/preflight/preflight.ts";

const tokens = (fields: Partial<ConstructorParameters<typeof TokenBreakdown>[0]>) =>
  new TokenBreakdown({ input: 0, cachedInput: 0, cacheWrite: 0, output: 0, ...fields });

// The models with `visibility: "list"` in `codex-rs/models-manager/models.json` at each
// `rust-v<version>` tag of openai/codex. Hidden models have no price on OpenAI's pricing page.
const codexCatalogs = {
  "0.164.0": [
    "gpt-6-astra",
    "gpt-6.1-sol",
    "gpt-6-sol",
    "gpt-6-luna",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-5.5",
  ],
  "0.159.0": [
    "gpt-6-astra",
    "gpt-6-sol",
    "gpt-6-luna",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-5.5",
  ],
  "0.159.1": [
    "gpt-6-astra",
    "gpt-6.1-sol",
    "gpt-6-sol",
    "gpt-6-luna",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-5.5",
  ],
  "0.159.2": [
    "gpt-6-astra",
    "gpt-6.1-sol",
    "gpt-6-sol",
    "gpt-6-luna",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-5.5",
  ],
  "0.159.3": [
    "gpt-6-astra",
    "gpt-6.1-sol",
    "gpt-6-sol",
    "gpt-6-luna",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-5.5",
  ],
} satisfies Readonly<Record<string, ReadonlyArray<string>>>;

describe("OpenAI prices", () => {
  it("has rates for every model that a supported Codex CLI version lists", () => {
    assert.deepStrictEqual(Object.keys(codexCatalogs), [...supportedCodexVersions]);
    const unpriced = Object.values(codexCatalogs)
      .flat()
      .filter((model) => Option.isNone(openAiPrice(model, tokens({}))));
    assert.deepStrictEqual(unpriced, []);
  });

  it("prices each kind of token at its own rate per million tokens", () => {
    const price = (fields: Partial<ConstructorParameters<typeof TokenBreakdown>[0]>) =>
      Option.getOrThrow(openAiPrice("gpt-5.6-terra", tokens(fields)));
    assert.strictEqual(price({ input: 1_000_000 }), 2);
    assert.strictEqual(price({ cachedInput: 1_000_000 }), 0.2);
    assert.strictEqual(price({ cacheWrite: 1_000_000 }), 2.5);
    assert.strictEqual(price({ output: 1_000_000 }), 12);
    assert.closeTo(
      price({ input: 3_000, cachedInput: 200_000, cacheWrite: 1_000, output: 1_000 }),
      (3_000 * 2 + 200_000 * 0.2 + 1_000 * 2.5 + 1_000 * 12) / 1_000_000,
      1e-12,
    );
  });

  it("prices cache writes at the input rate on a model without a write rate", () => {
    assert.deepStrictEqual(
      openAiPrice("gpt-5.5", tokens({ cacheWrite: 1_000_000 })),
      Option.some(5),
    );
  });

  it("has no price for a model that the table lacks", () => {
    assert(Option.isNone(openAiPrice("gpt-never-existed", tokens({ output: 1_000 }))));
    assert(Option.isNone(openAiPrice("codex-auto-review", tokens({ output: 1_000 }))));
  });
});

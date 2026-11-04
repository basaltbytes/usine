import type { TokenBreakdown, UsdAmount } from "@usine/core/agent/session";
import type { Option } from "effect";
import { codex } from "./harness/codex/descriptor.ts";

/** Returns OpenAI's price for a Codex model, or None when its bundled table has no rates. */
export const openAiPrice = (model: string, tokens: TokenBreakdown): Option.Option<UsdAmount> =>
  codex.price(model, tokens);

import { it } from "@effect/vitest";
import { Effect } from "effect";
import { checkReads } from "./fixture.ts";

it.live.each([
  {
    fixture:
      "keeps 300 done tasks and 837 runs below 500 KB, and reads every card, run, and item text through the operator tools in results that fit one tool result",
    initialItems: 301,
    openRuns: 1,
    history: true,
  },
])("$fixture", (fixture) => checkReads(fixture).pipe(Effect.asVoid), 120_000);

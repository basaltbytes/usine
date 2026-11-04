import { it } from "@effect/vitest";
import { Effect } from "effect";
import { checkReads } from "./fixture.ts";

it.live.each([
  {
    fixture: "keeps 300 done tasks and 800 runs below 500 KB with full task detail",
    initialItems: 301,
    openRuns: 1,
    history: true,
  },
  {
    fixture: "keeps 200 items and 50 open runs below 500 KB and returns concurrent reads",
    initialItems: 200,
    openRuns: 50,
    history: false,
  },
])("$fixture", (fixture) => checkReads(fixture).pipe(Effect.asVoid), 120_000);

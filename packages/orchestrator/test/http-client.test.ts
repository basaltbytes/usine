import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import { externalHttpClientLayer } from "../src/http-client.ts";

describe("External HTTP client", () => {
  it.effect("sends no trace headers to GitHub or a Gateway, even inside a span", () => {
    const sent: Array<Headers> = [];
    const recordingFetch: typeof globalThis.fetch = async (_input, init) => {
      sent.push(new Headers(init?.headers));
      return new Response("{}", { status: 200 });
    };
    return Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      yield* client.get("https://api.github.com/zen").pipe(Effect.withSpan("Test.pollCycle"));
      assert.lengthOf(sent, 1);
      assert.isFalse(sent[0]?.has("traceparent"));
      assert.isFalse(sent[0]?.has("b3"));
    }).pipe(
      Effect.provide(externalHttpClientLayer),
      Effect.provideService(FetchHttpClient.Fetch, recordingFetch),
    );
  });
});

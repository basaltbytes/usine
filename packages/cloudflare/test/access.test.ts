import { describe, expect, it } from "@effect/vitest";
import { Effect, Redacted } from "effect";
import { accessGranted } from "../src/access.ts";

const token = {
  clientId: Redacted.make("0123abcd.access"),
  clientSecret: Redacted.make("service-token-secret"),
};

describe("Access service token check", () => {
  it.effect("accepts only both headers with the configured values", () =>
    Effect.gen(function* () {
      const granted = (headers: Record<string, string>) =>
        accessGranted(new Headers(headers), token);

      expect(
        yield* granted({
          "CF-Access-Client-Id": "0123abcd.access",
          "CF-Access-Client-Secret": "service-token-secret",
        }),
      ).toBe(true);
      expect(yield* granted({})).toBe(false);
      expect(yield* granted({ "CF-Access-Client-Id": "0123abcd.access" })).toBe(false);
      expect(
        yield* granted({
          "CF-Access-Client-Id": "0123abcd.access",
          "CF-Access-Client-Secret": "service-token-secreT",
        }),
      ).toBe(false);
    }),
  );
});

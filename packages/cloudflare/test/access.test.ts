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

      const authorized = yield* granted({
        "CF-Access-Client-Id": "0123abcd.access",
        "CF-Access-Client-Secret": "service-token-secret",
      });
      expect(authorized).toBe(true);
      const currentAuthorized = yield* granted({});
      expect(currentAuthorized).toBe(false);
      const nextAuthorized = yield* granted({ "CF-Access-Client-Id": "0123abcd.access" });
      expect(nextAuthorized).toBe(false);
      const updatedAuthorized = yield* granted({
        "CF-Access-Client-Id": "0123abcd.access",
        "CF-Access-Client-Secret": "service-token-secreT",
      });
      expect(updatedAuthorized).toBe(false);
    }),
  );
});

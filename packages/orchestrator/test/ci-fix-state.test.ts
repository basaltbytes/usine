import { assert, describe, it } from "@effect/vitest";
import { needsCiFix } from "../src/polling/ci-fix-state.ts";

describe("needsCiFix", () => {
  it.each([
    { checks: "FAILURE", needed: true },
    { checks: "ERROR", needed: true },
    { checks: "PENDING", needed: false },
    { checks: "SUCCESS", needed: false },
  ] as const)(
    "an open pull request whose checks report $checks needs a fix: $needed",
    ({ checks, needed }) => {
      assert.strictEqual(
        needsCiFix({
          state: "OPEN",
          merged: false,
          mergeable: "MERGEABLE",
          statusCheckRollup: { state: checks },
        }),
        needed,
      );
    },
  );
});

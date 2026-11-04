import { assert, it } from "@effect/vitest";

it("propagates a failed matrix leg to the CI aggregate", () => {
  assert.fail("Intentional CI failure experiment for issue #928");
});

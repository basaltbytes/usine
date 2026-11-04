import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { RepositoryName } from "../src/repository.ts";

describe("Repository.Name", () => {
  it("rejects a repository without its owner", () => {
    expect(() => Effect.runSync(Schema.decodeEffect(RepositoryName)("usine"))).toThrow(
      "Expected a full GitHub repo name (owner/name)",
    );
  });
});

import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { RepositoryName } from "../src/repository.ts";

describe("Repository.Name", () => {
  it.effect("rejects a repository without its owner", () =>
    Effect.gen(function* () {
      expect((yield* Effect.flip(Schema.decodeEffect(RepositoryName)("usine"))).message).toContain(
        "Expected a full GitHub repo name (owner/name)",
      );
    }),
  );
});

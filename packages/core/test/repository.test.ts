import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";
import { RepositoryName } from "../src/repository.ts";

describe("Repository.Name", () => {
  it("rejects a repository without its owner", () => {
    expect(() => Schema.decodeUnknownSync(RepositoryName)("usine")).toThrow(
      "Expected a full GitHub repo name (owner/name)",
    );
  });
});

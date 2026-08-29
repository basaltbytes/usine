import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";
import { Repository } from "../src/index.ts";

describe("Repository.Name", () => {
  it("rejects a repository without its owner", () => {
    expect(() => Schema.decodeUnknownSync(Repository.Name)("usine")).toThrow(
      "Expected a full GitHub repo name (owner/name)",
    );
  });
});

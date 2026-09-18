import { SalvagePushed, SalvageRef, SalvageRetained } from "@usine/core/attempt/salvage";
import { CommitSha } from "@usine/core/repository";
import { Option } from "effect";
import { assert, describe, it } from "vitest";
import { salvageMessage } from "../src/operator-copy.ts";

describe("salvage copy in the run drawer", () => {
  it("names the pushed ref and short commit", () => {
    const message = salvageMessage(
      new SalvagePushed({
        ref: SalvageRef.make("usine/salvage/run/1"),
        commit: CommitSha.make("0123456789abcdef0123456789abcdef01234567"),
      }),
    );
    assert.include(message, "usine/salvage/run/1");
    assert.include(message, "0123456");
  });

  it("shows where retained work lives, that startup retries it, and why the last try failed", () => {
    const message = salvageMessage(
      new SalvageRetained({
        path: "/workers/local/attempts/run_execute_1",
        commit: Option.none(),
        message: "remote: Repository not found",
      }),
    );
    assert.include(message, "/workers/local/attempts/run_execute_1");
    assert.include(message, "every startup");
    assert.include(message, "remote: Repository not found");
  });
});

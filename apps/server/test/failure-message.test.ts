import { WorkerName } from "@usine/core/worker";
import { WorkerCapabilityError } from "@usine/executor";
import { assert, describe, it } from "vitest";
import { failureMessage } from "../src/failure-message.ts";

describe("CLI failure messages", () => {
  it("names the Worker, the failed check, and the cause of a preflight refusal", () => {
    const message = failureMessage(
      WorkerCapabilityError.make({
        worker: WorkerName.make("eu-one"),
        capability: "machine",
        message: 'Can\'t connect to SSH worker "eu-one" at usine@10.0.0.2',
        cause: new Error("Permission denied (publickey).\nsecond line"),
      }),
    );
    assert.strictEqual(
      message,
      'usine up did not start: worker "eu-one" failed its machine check: Can\'t connect to SSH worker "eu-one" at usine@10.0.0.2 (Permission denied (publickey)). Fix the worker or its entry under workers in usine.yaml, then run usine up again.',
    );
  });
});

import { FactoryConfigError, InstancePath } from "@usine/config/file";
import { WorkerName } from "@usine/core/worker";
import { EnginePersistenceError } from "@usine/engine/engine";
import { ExecutorOperationError, WorkerCapabilityError } from "@usine/executor";
import { assert, describe, it } from "vitest";
import { failureMessage } from "../src/failure-message.ts";

describe("CLI failure messages", () => {
  it("names the file, stage, and key of an invalid usine.yaml", () => {
    const message = failureMessage(
      new FactoryConfigError({
        file: InstancePath.make("usine.yaml"),
        stage: "schema",
        message: 'Expected a full GitHub repo name (owner/name)\n  at ["repos"][0]["name"]',
      }),
    );
    assert.include(message, "usine.yaml is invalid (schema)");
    assert.include(message, '["repos"][0]["name"]');
    assert.notInclude(message, "FactoryConfigError");
  });

  it("names a folder the instance load could not read", () => {
    const message = failureMessage(
      new FactoryConfigError({
        file: InstancePath.make("loops"),
        stage: "read",
        message: "ENOENT: no such file or directory",
      }),
    );
    assert.include(message, "could not read loops (ENOENT: no such file or directory)");
    assert.include(message, "instance folder");
  });

  it("names the Worker, the failed check, and the cause of a preflight refusal", () => {
    const message = failureMessage(
      new WorkerCapabilityError({
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

  it("does not repeat a cause the message already states", () => {
    const reason = "Claude Code is not logged in. Run claude login on the worker.";
    const message = failureMessage(
      new WorkerCapabilityError({
        worker: WorkerName.make("local"),
        capability: "harness-login",
        message: reason,
        cause: new Error(reason),
      }),
    );
    assert.include(
      message,
      'worker "local" failed its harness-login check: Claude Code is not logged in. Run claude login on the worker. Fix the worker',
    );
  });

  it("keeps the Worker named by the scheduler for an operation failure", () => {
    assert.strictEqual(
      failureMessage(
        new ExecutorOperationError({
          operation: "preflight",
          message: 'worker "local": The harness probe timed out',
          cause: new Error("timeout"),
        }),
      ),
      'usine up stopped: worker preflight failed: worker "local": The harness probe timed out (timeout).',
    );
  });

  it("names the runtime store operation and its cause", () => {
    assert.strictEqual(
      failureMessage(
        new EnginePersistenceError({
          operation: "initialize local database",
          cause: new Error("SQLITE_CANTOPEN: unable to open database file"),
        }),
      ),
      "usine up stopped: runtime store error: could not initialize local database (SQLITE_CANTOPEN: unable to open database file). Check .usine/runtime.sqlite and its folder.",
    );
  });
});

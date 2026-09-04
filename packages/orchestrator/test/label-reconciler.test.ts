import { assert, describe, it } from "@effect/vitest";
import { DeclaredLabel, GitHubLabelColor, GitHubLabelName } from "@usine/config";
import { Repository } from "@usine/core";
import { RepositoryLabel as StoredRepositoryLabel } from "@usine/engine";
import {
  GitHubApiError,
  GitHubLabelWriter,
  GitHubRateLimitError,
  RepositoryLabel,
  RepositoryLabelColor,
  RepositoryLabelName,
} from "@usine/github";
import { DateTime, Effect, Layer, Logger, Option } from "effect";
import { LabelReconciler } from "../src/label-reconciler.ts";

const repository = Repository.Name.make("basaltbytes/usine");
const declaration = (name: string, color?: string, description?: string) =>
  new DeclaredLabel({
    name: GitHubLabelName.make(name),
    color: color === undefined ? Option.none() : Option.some(GitHubLabelColor.make(color)),
    description: Option.fromNullishOr(description),
  });
const createdLabel = (name: string, color = "ededed", description?: string) =>
  new RepositoryLabel({
    name: RepositoryLabelName.make(name),
    color: RepositoryLabelColor.make(color),
    description: Option.fromNullishOr(description),
  });

const layer = (writer: GitHubLabelWriter["Service"]) =>
  LabelReconciler.layer.pipe(Layer.provide(Layer.succeed(GitHubLabelWriter, writer)));

describe("LabelReconciler", () => {
  it.effect("creates every declared label for a fresh repository", () => {
    const created: Array<string> = [];
    return Effect.gen(function* () {
      const reconciler = yield* LabelReconciler;
      const result = yield* reconciler.reconcile(
        repository,
        [declaration("ready", "A2EEEF"), declaration("review")],
        [],
      );

      assert.deepStrictEqual(created, ["ready", "review"]);
      assert.deepStrictEqual(
        result.labels.map(({ name, color }) => [name, Option.getOrNull(color)]),
        [
          ["ready", "A2EEEF"],
          ["review", "ededed"],
        ],
      );
      assert.deepStrictEqual(result.findings, []);
      assert.strictEqual(result.catalogChanged, true);
      assert(Option.isNone(result.nextPollAt));
    }).pipe(
      Effect.provide(
        layer({
          create: (_repository, label) =>
            Effect.sync(() => {
              created.push(label.name);
              return createdLabel(
                label.name,
                Option.getOrElse(label.color, () => RepositoryLabelColor.make("ededed")),
                Option.getOrUndefined(label.description),
              );
            }),
        }),
      ),
    );
  });

  it.effect("leaves a drifted existing label untouched and creates only the missing label", () => {
    const created: Array<string> = [];
    return Effect.gen(function* () {
      const logs: Array<{ readonly level: string; readonly message: string }> = [];
      const logger = Logger.make<unknown, void>(({ logLevel, message }) => {
        logs.push({
          level: logLevel,
          message: Array.isArray(message) ? message.map(String).join(" ") : String(message),
        });
      });
      const existing = new StoredRepositoryLabel({
        name: "ready",
        color: Option.some("000000"),
        description: Option.some("Existing definition"),
      });
      const reconciler = yield* LabelReconciler;
      const result = yield* reconciler
        .reconcile(
          repository,
          [declaration("ready", "ffffff", "Declared definition"), declaration("review")],
          [existing],
        )
        .pipe(Effect.withLogger(logger));

      assert.deepStrictEqual(created, ["review"]);
      assert.strictEqual(result.labels[0], existing);
      assert(logs.some(({ message }) => message.includes("left unchanged")));
    }).pipe(
      Effect.provide(
        layer({
          create: (_repository, label) =>
            Effect.sync(() => {
              created.push(label.name);
              return createdLabel(label.name);
            }),
        }),
      ),
    );
  });

  it.effect("reports one failed creation and continues creating sibling labels", () =>
    Effect.gen(function* () {
      const reconciler = yield* LabelReconciler;
      const result = yield* reconciler.reconcile(
        repository,
        [declaration("ready"), declaration("review")],
        [],
      );

      assert.deepStrictEqual(
        result.labels.map(({ name }) => name),
        ["review"],
      );
      assert.deepStrictEqual(
        result.findings.map(({ repository, label, errorTag }) => ({
          repository,
          label,
          errorTag,
        })),
        [
          {
            repository: "basaltbytes/usine",
            label: "ready",
            errorTag: "GitHubApiError",
          },
        ],
      );
      assert.strictEqual(result.catalogChanged, true);
    }).pipe(
      Effect.provide(
        layer({
          create: (_repository, label) =>
            label.name === "ready"
              ? Effect.fail(
                  new GitHubApiError({
                    operation: "create-repository-label",
                    status: Option.some(500),
                    message: "GitHub rejected the request with status 500",
                  }),
                )
              : Effect.succeed(createdLabel(label.name)),
        }),
      ),
    ),
  );

  it.effect("defers remaining creations when GitHub rate-limits the repository", () => {
    const attempted: Array<string> = [];
    const retryAt = DateTime.makeUnsafe("2026-09-03T10:00:00Z");
    return Effect.gen(function* () {
      const reconciler = yield* LabelReconciler;
      const result = yield* reconciler.reconcile(
        repository,
        [declaration("ready"), declaration("review")],
        [],
      );

      assert.deepStrictEqual(attempted, ["ready"]);
      assert.deepStrictEqual(
        result.findings.map(({ label }) => label),
        ["ready"],
      );
      assert.deepStrictEqual(Option.getOrNull(result.nextPollAt), retryAt);
    }).pipe(
      Effect.provide(
        layer({
          create: (_repository, label) => {
            attempted.push(label.name);
            return Effect.fail(
              new GitHubRateLimitError({
                operation: "create-repository-label",
                retryAt,
                message: "GitHub rate limit reached",
              }),
            );
          },
        }),
      ),
    );
  });
});

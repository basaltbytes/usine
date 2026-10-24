import { canonicalLabelName, type DeclaredLabel, GitHubLabelName } from "@usine/config/label";
import { RepositoryName } from "@usine/core/repository";
import { RepositoryLabel as StoredRepositoryLabel } from "@usine/engine/repository-label-projection";
import { GitHubLabelWriter, NewRepositoryLabel } from "@usine/github/label-writer";
import { RepositoryLabelColor, RepositoryLabelName } from "@usine/github/polling";
import { Context, DateTime, Effect, Layer, Option, Result, Schema } from "effect";

export class LabelPreflightFinding extends Schema.Class<LabelPreflightFinding>(
  "@usine/orchestrator/LabelPreflightFinding",
)({
  repository: RepositoryName,
  label: GitHubLabelName,
  errorTag: Schema.NonEmptyString,
  message: Schema.NonEmptyString,
}) {}

export interface LabelReconciliation {
  readonly labels: ReadonlyArray<StoredRepositoryLabel>;
  readonly findings: ReadonlyArray<LabelPreflightFinding>;
  /** Whether a label was created, so the poll cursor must drop its catalog ETag. */
  readonly catalogChanged: boolean;
  /**
   * The time a creation rate limit asks the next cycle to wait until. This cycle's triggers still
   * run.
   */
  readonly nextPollAt: Option.Option<DateTime.Utc>;
}

const driftFields = (
  declared: DeclaredLabel,
  existing: StoredRepositoryLabel,
): ReadonlyArray<"color" | "description"> => {
  const drift: Array<"color" | "description"> = [];
  if (Option.isSome(declared.color)) {
    const expected = declared.color.value.toLowerCase();
    if (
      Option.match(existing.color, {
        onNone: () => true,
        onSome: (color) => color.toLowerCase() !== expected,
      })
    ) {
      drift.push("color");
    }
  }
  if (Option.isSome(declared.description)) {
    const expected = declared.description.value;
    if (
      Option.match(existing.description, {
        onNone: () => true,
        onSome: (description) => description !== expected,
      })
    ) {
      drift.push("description");
    }
  }
  return drift;
};

const createInput = (label: DeclaredLabel): NewRepositoryLabel =>
  new NewRepositoryLabel({
    name: RepositoryLabelName.make(label.name),
    color: Option.map(label.color, RepositoryLabelColor.make),
    description: label.description,
  });

/** Creates the labels a factory declares that one repository's stored catalog lacks. */
export class LabelReconciler extends Context.Service<
  LabelReconciler,
  {
    readonly reconcile: (
      repository: RepositoryName,
      declared: ReadonlyArray<DeclaredLabel>,
      existing: ReadonlyArray<StoredRepositoryLabel>,
    ) => Effect.Effect<LabelReconciliation>;
  }
>()("@usine/orchestrator/LabelReconciler") {
  static readonly layer = Layer.effect(
    LabelReconciler,
    Effect.gen(function* () {
      const github = yield* GitHubLabelWriter;

      return {
        reconcile: Effect.fn("LabelReconciler.reconcile")(function* (
          repository: RepositoryName,
          declared: ReadonlyArray<DeclaredLabel>,
          existing: ReadonlyArray<StoredRepositoryLabel>,
        ) {
          yield* Effect.annotateCurrentSpan({ repository });
          const labels = [...existing];
          const byName = new Map(existing.map((label) => [canonicalLabelName(label.name), label]));
          const findings: Array<LabelPreflightFinding> = [];
          let catalogChanged = false;
          let nextPollAt = Option.none<DateTime.Utc>();

          for (const declaration of declared) {
            const current = byName.get(canonicalLabelName(declaration.name));
            if (current !== undefined) {
              const drift = driftFields(declaration, current);
              if (drift.length > 0) {
                yield* Effect.logWarning(
                  "Declared GitHub label differs from the existing repository label; left unchanged",
                  {
                    repository,
                    label: declaration.name,
                    drift: drift.join(", "),
                  },
                );
              } else {
                yield* Effect.logDebug("Declared GitHub label already exists", {
                  repository,
                  label: declaration.name,
                });
              }
              continue;
            }

            const created = yield* Effect.result(
              github.create(repository, createInput(declaration)),
            );
            if (Result.isFailure(created)) {
              const error = created.failure;
              findings.push(
                new LabelPreflightFinding({
                  repository,
                  label: declaration.name,
                  errorTag: error._tag,
                  message: error.message,
                }),
              );
              if (error._tag === "GitHubRateLimitError") {
                nextPollAt = Option.some(error.retryAt);
                yield* Effect.logWarning(
                  "Label creation rate-limited; remaining declarations deferred and trigger evaluation continues",
                  {
                    repository,
                    label: declaration.name,
                    errorTag: error._tag,
                    message: error.message,
                    retryAt: DateTime.formatIso(error.retryAt),
                  },
                );
                break;
              }
              yield* Effect.logError(
                "Declared GitHub label could not be created; trigger evaluation continues",
                {
                  repository,
                  label: declaration.name,
                  errorTag: error._tag,
                  message: error.message,
                },
              );
              continue;
            }

            const label = new StoredRepositoryLabel({
              name: created.success.name,
              color: Option.some(created.success.color),
              description: created.success.description,
            });
            labels.push(label);
            byName.set(canonicalLabelName(label.name), label);
            catalogChanged = true;
            yield* Effect.logInfo("Created declared GitHub label", {
              repository,
              label: label.name,
            });
          }

          labels.sort((left, right) => left.name.localeCompare(right.name));
          return { labels, findings, catalogChanged, nextPollAt } satisfies LabelReconciliation;
        }),
      };
    }),
  );
}

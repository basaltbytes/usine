import type { ModelOutcomeView } from "@usine/orchestrator/operator";
import { FirstReviewChart } from "~/components/statistics/models/chart";
import { comparisonLine, firstReviewTitle, modelLines, sameModel } from "~/lib/statistics/models";

type ModelEntryProps = {
  readonly outcome: ModelOutcomeView;
  readonly configured: boolean;
};

const ModelEntry = ({ outcome, configured }: ModelEntryProps) => (
  <li className="flex min-w-0 flex-col gap-0.5">
    <p className="flex flex-wrap items-baseline gap-x-2">
      <code className="font-mono text-xs text-foreground">{outcome.model}</code>
      <span className="text-xs text-muted-foreground">{outcome.harness}</span>
      {configured && <span className="text-xs font-medium text-foreground">Configured</span>}
    </p>
    {modelLines(outcome).map((line) => (
      <p key={line} className="text-sm text-muted-foreground">
        {line}
      </p>
    ))}
  </li>
);

type ModelComparisonProps = {
  readonly models: ReadonlyArray<ModelOutcomeView>;
  /** The agent's configured harness and model, marked in the list when present. */
  readonly configured?: Pick<ModelOutcomeView, "harness" | "model"> | undefined;
};

/**
 * Compares the models of one agent by the merged tasks of its first attempts: a sentence that
 * names the model whose tasks passed the first review most often, a chart, and one entry per model.
 */
export const ModelComparison = ({ models, configured }: ModelComparisonProps) => {
  const comparison = comparisonLine(models);
  return (
    <div className="flex min-w-0 flex-col gap-4">
      {comparison !== null && <p className="text-sm text-pretty">{comparison}</p>}
      <div className="flex flex-col gap-1">
        <p className="text-xs text-muted-foreground">{firstReviewTitle}</p>
        <FirstReviewChart models={models} />
      </div>
      <ul className="flex flex-col gap-3">
        {models.map((outcome) => (
          <ModelEntry
            key={`${outcome.harness}/${outcome.model}`}
            outcome={outcome}
            configured={configured !== undefined && sameModel(outcome, configured)}
          />
        ))}
      </ul>
    </div>
  );
};

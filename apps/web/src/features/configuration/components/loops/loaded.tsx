import { entityKey } from "~/features/configuration/lib/entities";
import { WarningIcon } from "@phosphor-icons/react";
import type {
  ConfigurationView,
  LoopFileView,
  LoopSelectorView,
} from "@usine/orchestrator/operator";
import { ErrorAlert } from "~/components/error-alert";
import { LoopFacts } from "~/features/configuration/components/loops/facts";
import { LoopState } from "~/features/configuration/components/loops/state";
import { type PauseLoop } from "~/features/configuration/components/loops/list";
import { PauseButton } from "~/features/configuration/components/loops/pause-button";
import { interpolations, PromptMarkdown } from "~/features/configuration/components/prompt";
import {
  ConfigurationPage,
  DetailColumns,
  DetailSection,
  Frontmatter,
} from "~/features/configuration/components/section";
import { plural } from "~/features/configuration/strings";

const triggerEntries = (loop: LoopFileView): ReadonlyArray<readonly [string, string]> => [
  ["on", loop.stream],
  ["if", loop.condition],
  ...(loop.cron === null ? [] : [["cron", loop.cron] as const]),
  ...(loop.timeZone === null ? [] : [["tz", loop.timeZone] as const]),
];

const selectorEntries = ({
  repos,
  tags,
}: LoopSelectorView): ReadonlyArray<readonly [string, string]> => [
  ...(repos === null ? [] : [["repos", repos.join(", ")] as const]),
  ...(tags === null ? [] : [["tags", tags.join(", ")] as const]),
];

type LoadedLoopProps = {
  readonly loop: LoopFileView;
  readonly configuration: ConfigurationView;
  readonly pause: PauseLoop | null;
};

export const LoadedLoop = ({ loop, configuration, pause }: LoadedLoopProps) => {
  const expressions = interpolations(loop.prompt).length;
  return (
    <ConfigurationPage
      entity={entityKey("loop", loop.name)}
      title={loop.name}
      marks={<LoopState paused={loop.paused} />}
      file={loop.file}
      actions={pause !== null && <PauseButton loop={loop} pause={pause} variant="outline" />}
    >
      {pause?.isError === true && <ErrorAlert message={pause.error.message} />}
      <DetailColumns facts={<LoopFacts loop={loop} configuration={configuration} />}>
        <DetailSection title="Trigger">
          <Frontmatter entries={triggerEntries(loop)} />
          {loop.undeclaredLabels.length > 0 && (
            <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
              <WarningIcon weight="fill" className="mt-0.5 size-3 shrink-0 text-warning" />
              <span>
                Condition uses{" "}
                {loop.undeclaredLabels.length === 1 ? "an undeclared label" : "undeclared labels"}:{" "}
                {loop.undeclaredLabels.join(", ")}. usine creates only the labels under{" "}
                <code>labels</code> in <code>usine.yaml</code>.
              </span>
            </p>
          )}
        </DetailSection>
        <DetailSection title="Selector">
          {loop.selector === null ? (
            <p className="text-muted-foreground">No selector: every registered repository</p>
          ) : (
            <Frontmatter entries={selectorEntries(loop.selector)} />
          )}
        </DetailSection>
        <DetailSection
          title="Prompt"
          aside={
            expressions === 0
              ? "Same text for every run"
              : `${plural(expressions, "outlined expression")} filled in from each item`
          }
        >
          <PromptMarkdown template={loop.prompt} />
        </DetailSection>
      </DetailColumns>
    </ConfigurationPage>
  );
};

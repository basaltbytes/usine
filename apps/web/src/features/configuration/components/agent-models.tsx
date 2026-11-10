import { useQuery } from "@tanstack/react-query";
import type { AgentFileView, StatisticsWindow } from "@usine/orchestrator/operator";
import { useState } from "react";
import { ErrorAlert } from "~/components/error-alert";
import { ModelComparison } from "~/components/statistics/models/comparison";
import { WindowToggle } from "~/components/statistics/window-toggle";
import { Skeleton } from "~/components/ui/skeleton";
import { DetailSection } from "~/features/configuration/components/section";
import { agentCopy, noModelTasksLine } from "~/features/configuration/strings";
import { statisticsQuery } from "~/lib/statistics/queries";
import { cn } from "~/lib/utils";

type AgentModelsProps = { readonly agent: AgentFileView };

/** The models this agent ran with on the merged tasks of the selected window. */
export const AgentModels = ({ agent }: AgentModelsProps) => {
  const [selected, setSelected] = useState<StatisticsWindow>("30d");
  const query = useQuery(statisticsQuery(selected));
  const statistics = query.data;
  const models = statistics?.agents.find(({ agent: name }) => name === agent.name)?.models ?? [];
  return (
    <DetailSection title={agentCopy.models} aside={agentCopy.modelsNote}>
      <div className="flex flex-col gap-4">
        <WindowToggle value={selected} onChange={setSelected} />
        {statistics === undefined ? (
          query.isError ? (
            <ErrorAlert title={agentCopy.modelsError} message={query.error.message} />
          ) : (
            <Skeleton aria-hidden="true" className="h-24 w-full" />
          )
        ) : (
          <div
            aria-busy={query.isPlaceholderData}
            className={cn(
              "transition-opacity duration-(--duration-fast)",
              query.isPlaceholderData && "opacity-60",
            )}
          >
            {models.length === 0 ? (
              <p className="text-sm text-muted-foreground">{noModelTasksLine(statistics.window)}</p>
            ) : (
              <ModelComparison models={models} configured={agent} />
            )}
          </div>
        )}
      </div>
    </DetailSection>
  );
};

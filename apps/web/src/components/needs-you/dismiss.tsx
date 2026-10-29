import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  attentionKey,
  type FactoryOverview,
  type NeedView,
  projectAttention,
  ReadyOverview,
  NeedsSetupOverview,
} from "@usine/orchestrator/operator";
import { DropdownMenuItem } from "~/components/ui/dropdown-menu";
import { Button } from "~/components/ui/button";
import { api } from "~/lib/api";
import { attentionActionLabel, attentionActionProgress } from "~/lib/needs-you/strings";
import { overviewQuery } from "~/lib/overview";

type DismissNeedProps = {
  readonly need: NeedView;
  readonly action: "dismissNeed" | "undoDismissNeed";
};

export const DismissNeed = ({ need, action }: DismissNeedProps) => {
  const queries = useQueryClient();
  const key = attentionKey(need);
  const mutation = useMutation({
    mutationFn: () => api((client) => client[action]({ payload: key })),
    onSuccess: async () => {
      await queries.cancelQueries({ queryKey: overviewQuery().queryKey });
      queries.setQueryData<FactoryOverview>(overviewQuery().queryKey, (overview) => {
        if (overview === undefined) return overview;
        const source = action === "dismissNeed" ? overview.needsYou : overview.dismissedNeeds;
        const matching = source.filter(
          (entry) => entry.id === key.id && attentionKey(entry).revision === key.revision,
        );
        const remaining = source.filter((entry) => !matching.includes(entry));
        const needsYou = action === "dismissNeed" ? remaining : [...overview.needsYou, ...matching];
        const dismissedNeeds =
          action === "dismissNeed" ? [...overview.dismissedNeeds, ...matching] : remaining;
        const fields = {
          needsYou,
          dismissedNeeds,
          projects: projectAttention(overview.projects, needsYou),
        };
        return overview._tag === "Ready"
          ? new ReadyOverview({ ...overview, ...fields })
          : new NeedsSetupOverview({ ...overview, ...fields });
      });
      await queries.invalidateQueries({ queryKey: overviewQuery().queryKey });
    },
  });
  return (
    <span className="flex flex-col items-end gap-1">
      {action === "dismissNeed" ? (
        <DropdownMenuItem
          className="w-full"
          closeOnClick={false}
          disabled={mutation.isPending}
          onClick={() => mutation.mutate()}
        >
          {mutation.isPending ? attentionActionProgress[action] : attentionActionLabel[action]}
        </DropdownMenuItem>
      ) : (
        <Button variant="ghost" disabled={mutation.isPending} onClick={() => mutation.mutate()}>
          {mutation.isPending ? attentionActionProgress[action] : attentionActionLabel[action]}
        </Button>
      )}
      {mutation.isError && (
        <span role="alert" className="max-w-64 text-xs text-destructive wrap-anywhere">
          {mutation.error.message}
        </span>
      )}
    </span>
  );
};

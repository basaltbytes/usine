import { Button } from "~/components/ui/button";
import { type RunFailure } from "~/lib/projects/failure";
import { type RunActions } from "~/hooks/runs/actions";
import { runActionLabel } from "~/lib/runs/strings";

type RetryButtonProps = {
  readonly failure: RunFailure;
  readonly action: RunActions | null;
};

export const RetryButton = ({ failure, action }: RetryButtonProps) =>
  action !== null && failure.run.canRetry && !action.isPending ? (
    <Button
      variant="outline"
      size="xs"
      className="relative z-10"
      onClick={() => action.mutate({ runId: failure.run.id, request: { action: "retry" } })}
    >
      {runActionLabel.retry}
    </Button>
  ) : null;

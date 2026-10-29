import { useQuery } from "@tanstack/react-query";
import type {
  ConfigurationEntityKey,
  ConfigurationRevisionNumber,
} from "@usine/config/configuration";
import { OperatorHttpError } from "@usine/orchestrator/operator/http";
import { CodeBlock } from "~/components/ai-elements/code-block";
import { Button } from "~/components/ui/button";
import { ErrorAlert } from "~/components/error-alert";
import { entityQuery } from "~/features/configuration/queries";
import { configurationDiff } from "~/features/configuration/lib/diff";
import { editorCopy } from "~/features/configuration/strings";

type ConflictProps = {
  readonly entity: ConfigurationEntityKey;
  readonly before: string;
  readonly number: ConfigurationRevisionNumber;
  readonly reload: (current: {
    readonly text: string;
    readonly number: ConfigurationRevisionNumber;
  }) => void;
};

export const Conflict = ({ entity, before, number, reload }: ConflictProps) => {
  const current = useQuery({ ...entityQuery(entity), staleTime: 0, refetchOnMount: "always" });
  const deleted =
    current.error instanceof OperatorHttpError && current.error.error === "ConfigurationNotFound";
  const text = deleted ? "" : current.data?.text;
  const loadedNumber = deleted ? number : current.data?.number;
  return (
    <section className="flex min-w-0 flex-col gap-3" aria-label={editorCopy.conflict}>
      <p role="alert" className="text-warning">
        {editorCopy.conflict}
      </p>
      {current.isPending && <p role="status">{editorCopy.loading}</p>}
      {current.isError && !deleted && <ErrorAlert message={current.error.message} />}
      {text !== undefined && loadedNumber !== undefined && !current.isFetching && (
        <>
          <p>{editorCopy.revision(loadedNumber)}</p>
          {deleted && <p>{editorCopy.deletedConflict}</p>}
          <CodeBlock
            code={configurationDiff(entity.key, before, text) || editorCopy.noDiff}
            language="diff"
          />
          <div>
            <Button
              variant="outline"
              onClick={() => {
                reload({ text, number: loadedNumber });
              }}
            >
              {editorCopy.reload}
            </Button>
          </div>
        </>
      )}
    </section>
  );
};

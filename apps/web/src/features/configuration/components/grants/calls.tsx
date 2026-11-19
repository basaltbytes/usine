import { useSuspenseQuery } from "@tanstack/react-query";
import { InstanceScope, ProjectScope } from "@usine/core/access";
import { StatusBadge } from "~/components/status-badge";
import { Button } from "~/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { Time } from "~/features/configuration/components/grants/time";
import { grantCopy } from "~/features/configuration/strings";
import { useScopeName } from "~/hooks/use-conversation-access";
import { useOpenConversation } from "~/hooks/use-open-conversation";
import { allowedCallsQuery } from "~/lib/conversations/queries";
import { allowanceLabel, callOutcome } from "~/lib/conversations/requests";
import type { PermissionRequest } from "~/lib/conversations/timeline";

type CallRowProps = { readonly call: PermissionRequest };

const CallRow = ({ call }: CallRowProps) => {
  const open = useOpenConversation();
  const project = useScopeName(
    call.project === null ? InstanceScope.make() : ProjectScope.make({ project: call.project }),
  );
  const { state } = call;
  if (state._tag === "Waiting" || state._tag === "Denied") return null;
  const { mark, label } = callOutcome(state);
  return (
    <TableRow variant="static">
      <TableCell size="roomy" className="whitespace-normal">
        <span className="block font-medium">{call.summary}</span>
        <span className="block font-mono text-xs text-muted-foreground wrap-anywhere">
          {call.target}
        </span>
      </TableCell>
      <TableCell className="hidden sm:table-cell">{project}</TableCell>
      <TableCell className="whitespace-normal">
        <span className="block">{allowanceLabel(state.allowance, project)}</span>
        <Time at={state.allowance.at} />
      </TableCell>
      <TableCell className="whitespace-normal">
        <StatusBadge state={mark} label={label} />
        {state._tag === "Failed" && (
          <span className="mt-1 line-clamp-2 block text-xs text-muted-foreground wrap-anywhere">
            {state.error}
          </span>
        )}
      </TableCell>
      <TableCell className="text-right">
        <Button
          variant="ghost"
          size="sm"
          className="pointer-coarse:h-11"
          aria-label={grantCopy.openConversation}
          onClick={() => open(call.conversation)}
        >
          {grantCopy.open}
        </Button>
      </TableCell>
    </TableRow>
  );
};

/** The calls that supervisor turns ran in conversations that the member can read. */
export const AllowedCalls = () => {
  const { data } = useSuspenseQuery(allowedCallsQuery());
  if (data.actions.length === 0)
    return <p className="text-sm text-muted-foreground">{grantCopy.noCalls}</p>;
  return (
    <div className="-mx-2">
      <Table>
        <TableHeader>
          <TableRow variant="static">
            <TableHead>{grantCopy.call}</TableHead>
            <TableHead className="hidden sm:table-cell">{grantCopy.project}</TableHead>
            <TableHead>{grantCopy.allowed}</TableHead>
            <TableHead>{grantCopy.outcome}</TableHead>
            <TableHead>
              <span className="sr-only">{grantCopy.conversation}</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.actions.map((call) => (
            <CallRow key={call.id} call={call} />
          ))}
        </TableBody>
      </Table>
    </div>
  );
};

import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { ProjectScope } from "@usine/core/access";
import type { StandingGrantId } from "@usine/core/permission-request";
import type { StandingGrantsView } from "@usine/orchestrator/operator/http";
import { EmptyList } from "~/components/empty-list";
import { ErrorAlert } from "~/components/error-alert";
import { StateMark } from "~/components/status-badge";
import { TextTooltip } from "~/components/text-tooltip";
import { TwoStepButton } from "~/components/two-step-button";
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
import { conversationApi, rejectionMessage } from "~/lib/api";
import { allowedCallsQuery, grantsQuery } from "~/lib/conversations/queries";

type Grant = (typeof StandingGrantsView.Type)["grants"][number];

type GrantRowProps = {
  readonly grant: Grant;
  readonly revoke: (id: StandingGrantId) => void;
  readonly pending: boolean;
};

const GrantRow = ({ grant, revoke, pending }: GrantRowProps) => {
  const project = useScopeName(ProjectScope.make({ project: grant.project }));
  return (
    <TableRow variant="static">
      <TableCell size="roomy" className="whitespace-normal">
        <span className="block font-medium">{grant.summary}</span>
        <span className="block font-mono text-xs text-muted-foreground">{grant.operation}</span>
        {!grant.applies && (
          <TextTooltip text={grantCopy.inactiveHint(grant.member.login)}>
            <span className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
              <StateMark state="paused" />
              {grantCopy.inactive}
            </span>
          </TextTooltip>
        )}
      </TableCell>
      <TableCell>{project}</TableCell>
      <TableCell>
        <span className="font-mono text-xs">{grant.member.login}</span>
      </TableCell>
      <TableCell className="hidden md:table-cell">
        <Time at={grant.createdAt} />
      </TableCell>
      <TableCell className="hidden sm:table-cell">
        {grant.lastUsedAt === null ? (
          <span className="text-muted-foreground">{grantCopy.never}</span>
        ) : (
          <Time at={grant.lastUsedAt} />
        )}
      </TableCell>
      <TableCell>
        {grant.revocable && (
          <span className="flex justify-end">
            <TwoStepButton
              label={grantCopy.revoke}
              keepLabel={grantCopy.keep}
              confirmLabel={grantCopy.confirmRevoke}
              pending={pending}
              confirm={() => revoke(grant.id)}
            />
          </span>
        )}
      </TableCell>
    </TableRow>
  );
};

/** The standing grants that the member can read, each with revocation when the member may revoke it. */
export const GrantsTable = () => {
  const { data } = useSuspenseQuery(grantsQuery());
  const queryClient = useQueryClient();
  const key = grantsQuery().queryKey;
  const revoke = useMutation({
    mutationFn: (grant: StandingGrantId) =>
      conversationApi((client) => client.revokeSupervisorGrant({ params: { grant } })),
    onMutate: async (grant) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData(key);
      if (previous !== undefined)
        queryClient.setQueryData(key, {
          grants: previous.grants.filter(({ id }) => id !== grant),
        });
      return { previous };
    },
    onError: (_error, _grant, context) => {
      if (context?.previous !== undefined) queryClient.setQueryData(key, context.previous);
    },
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: key }),
        queryClient.invalidateQueries({ queryKey: allowedCallsQuery().queryKey }),
      ]),
  });
  return (
    <div className="space-y-3">
      {revoke.isError && <ErrorAlert message={rejectionMessage(revoke.error)} />}
      {data.grants.length === 0 ? (
        <EmptyList title={grantCopy.empty.title} description={grantCopy.empty.description} />
      ) : (
        <div className="-mx-2">
          <Table>
            <TableHeader>
              <TableRow variant="static">
                <TableHead>{grantCopy.operation}</TableHead>
                <TableHead>{grantCopy.project}</TableHead>
                <TableHead>{grantCopy.grantedBy}</TableHead>
                <TableHead className="hidden md:table-cell">{grantCopy.created}</TableHead>
                <TableHead className="hidden sm:table-cell">{grantCopy.lastUsed}</TableHead>
                <TableHead>
                  <span className="sr-only">{grantCopy.revoke}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.grants.map((grant) => (
                <GrantRow
                  key={grant.id}
                  grant={grant}
                  revoke={(id) => revoke.mutate(id)}
                  pending={revoke.isPending && revoke.variables === grant.id}
                />
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
};

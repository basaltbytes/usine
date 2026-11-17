import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { ConversationsView } from "@usine/orchestrator/operator/http";
import { DateTime } from "effect";
import { EmptyList } from "~/components/empty-list";
import { SetupRequired } from "~/components/conversations/footer";
import { OpeningRow, rowLinkClass } from "~/components/opening-row";
import { Page, PageHeading } from "~/components/page";
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
import { FillCell } from "~/components/fill-cell";
import { useMember, useScopeChoices, useScopeName } from "~/hooks/use-conversation-access";
import { useNow } from "~/hooks/use-now";
import { useOpenConversation } from "~/hooks/use-open-conversation";
import { conversationsQuery, conversationStatusQuery } from "~/lib/conversations/queries";
import {
  conversationColumn,
  conversationCount,
  conversationsTitle,
  emptyListDescription,
  emptyListTitle,
  lastTurnColumn,
  newConversationLabel,
  noTurn,
  scopeLabel,
  startedByColumn,
  startedColumn,
  turnStateLabel,
} from "~/lib/conversations/strings";
import { agoLabel, timestampLabel } from "~/lib/strings";

type Entry = (typeof ConversationsView.Type)["conversations"][number];

type ConversationRowProps = { readonly entry: Entry; readonly now: number };

const ConversationRow = ({ entry, now }: ConversationRowProps) => {
  const open = useOpenConversation();
  const { conversation, lastTurn } = entry;
  const scope = useScopeName(conversation.scope);
  const started = DateTime.formatIso(conversation.createdAt);
  return (
    <OpeningRow open={() => open(conversation.id)}>
      <FillCell className="py-3">
        <Link
          to="."
          search={(previous) => ({ ...previous, conversation: conversation.id })}
          onClick={(event) => event.stopPropagation()}
          className={`${rowLinkClass} block truncate`}
          title={conversation.title}
        >
          {conversation.title}
        </Link>
      </FillCell>
      <TableCell className="hidden sm:table-cell">{scope}</TableCell>
      <TableCell className="hidden md:table-cell">{conversation.createdBy}</TableCell>
      <TableCell className="hidden font-mono text-xs text-muted-foreground tabular-nums md:table-cell">
        <time dateTime={started} title={timestampLabel(started)}>
          {agoLabel(started, now)}
        </time>
      </TableCell>
      <TableCell>
        {lastTurn === null ? (
          <span className="text-xs text-muted-foreground">{noTurn}</span>
        ) : (
          <StatusBadge state={lastTurn.state._tag} label={turnStateLabel(lastTurn.state)} />
        )}
      </TableCell>
    </OpeningRow>
  );
};

/** The conversations the member can read, newest first; a row opens the conversation panel. */
export const ConversationsPage = () => {
  const { data } = useSuspenseQuery(conversationsQuery());
  const status = useQuery(conversationStatusQuery());
  const choices = useScopeChoices();
  const member = useMember();
  const open = useOpenConversation();
  const now = useNow(30_000);
  const canStart = status.data?.state === "ready" && member !== undefined && choices.length > 0;
  const create = canStart ? (
    <Button onClick={() => open("new")}>{newConversationLabel}</Button>
  ) : undefined;
  return (
    <Page width="full">
      <PageHeading
        title={conversationsTitle}
        counts={
          data.conversations.length === 0 ? undefined : conversationCount(data.conversations.length)
        }
        actions={data.conversations.length === 0 ? undefined : create}
      />
      {status.data?.state === "setup-required" && (
        <div className="max-w-3xl">
          <SetupRequired reason={status.data.reason ?? ""} />
        </div>
      )}
      {data.conversations.length === 0 ? (
        <EmptyList title={emptyListTitle} description={emptyListDescription} action={create} />
      ) : (
        <div className="-mx-2">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>{conversationColumn}</TableHead>
                <TableHead className="hidden sm:table-cell">{scopeLabel}</TableHead>
                <TableHead className="hidden md:table-cell">{startedByColumn}</TableHead>
                <TableHead className="hidden md:table-cell">{startedColumn}</TableHead>
                <TableHead>{lastTurnColumn}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.conversations.map((entry) => (
                <ConversationRow key={entry.conversation.id} entry={entry} now={now} />
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </Page>
  );
};

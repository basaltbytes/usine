import { useQuery } from "@tanstack/react-query";
import type { ConversationId } from "@usine/core/conversation";
import type { ConversationsView } from "@usine/orchestrator/operator/http";
import { StatusBadge } from "~/components/status-badge";
import { useScopeName } from "~/hooks/use-conversation-access";
import { conversationsQuery } from "~/lib/conversations/queries";
import { noTurn, recentConversationsLabel, turnStateLabel } from "~/lib/conversations/strings";

/** How many conversations the new-conversation panel lists. */
const RECENT = 5;

type Entry = (typeof ConversationsView.Type)["conversations"][number];

type RecentRowProps = {
  readonly entry: Entry;
  readonly open: (id: ConversationId) => void;
};

const RecentRow = ({ entry, open }: RecentRowProps) => {
  const scope = useScopeName(entry.conversation.scope);
  return (
    <li>
      <button
        type="button"
        onClick={() => open(entry.conversation.id)}
        className="-mx-2 flex w-[calc(100%+1rem)] min-w-0 items-baseline gap-3 rounded-md px-2 py-2 text-left outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring/70 max-sm:min-h-11"
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{entry.conversation.title}</span>
          <span className="block truncate text-xs text-muted-foreground">
            {scope} · {entry.conversation.createdBy}
          </span>
        </span>
        {entry.lastTurn === null ? (
          <span className="shrink-0 text-xs text-muted-foreground">{noTurn}</span>
        ) : (
          <StatusBadge
            state={entry.lastTurn.state._tag}
            label={turnStateLabel(entry.lastTurn.state)}
          />
        )}
      </button>
    </li>
  );
};

type RecentConversationsProps = { readonly open: (id: ConversationId) => void };

/** Lists the newest conversations the member can read, so the panel opens one from any page. */
export const RecentConversations = ({ open }: RecentConversationsProps) => {
  const { data = [] } = useQuery({
    ...conversationsQuery(),
    select: (view) => view.conversations.slice(0, RECENT),
  });
  if (data.length === 0) return null;
  return (
    <section aria-labelledby="recent-conversations" className="space-y-1">
      <h3 id="recent-conversations" className="text-xs font-medium text-muted-foreground">
        {recentConversationsLabel}
      </h3>
      <ul>
        {data.map((entry) => (
          <RecentRow key={entry.conversation.id} entry={entry} open={open} />
        ))}
      </ul>
    </section>
  );
};

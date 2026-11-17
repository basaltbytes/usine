import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { ConversationId } from "@usine/core/conversation";
import { FactoryOverview } from "@usine/orchestrator/operator";
import { ChangeNotice } from "@usine/orchestrator/operator/http";
import { Schema } from "effect";
import { afterEach, expect, it } from "vitest";
import { invalidateChanges } from "~/lib/changes";
import {
  conversationEventsQuery,
  conversationQuery,
  conversationsQuery,
} from "~/lib/conversations/queries";
import {
  ada,
  answered,
  conversationId,
  conversationOf,
  conversationServer,
  turnEvents,
} from "~/lib/conversations/fixture";
import { overviewQuery } from "~/lib/overview";
import { taskOverview } from "~/lib/tasks/fixture";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

it("reads only the new events, the conversation, and the list on the conversation's change notice", async () => {
  const overviewReads: Array<string> = [];
  const fake = conversationServer(async (url) => {
    overviewReads.push(url.pathname);
    return new Response(JSON.stringify(Schema.encodeSync(FactoryOverview)(taskOverview())), {
      headers: { "content-type": "application/json" },
    });
  });
  globalThis.fetch = fake.fetch;
  const other = ConversationId.make("c-2");
  const record = conversationOf([
    { turn: "t-1", member: ada, text: "Hello", minute: 1, state: answered(1), answer: "Hi." },
  ]);
  fake.server.conversations.set(conversationId, record);
  fake.server.conversations.set(other, {
    ...record,
    conversation: { ...record.conversation, id: other },
  });
  fake.server.events.set(conversationId, turnEvents("t-1", 1, false));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ignore = () => undefined;
  const observed = [
    new QueryObserver(client, conversationQuery(conversationId)).subscribe(ignore),
    new QueryObserver(client, conversationEventsQuery(client, conversationId)).subscribe(ignore),
    new QueryObserver(client, conversationsQuery()).subscribe(ignore),
    new QueryObserver(client, conversationQuery(other)).subscribe(ignore),
    new QueryObserver(client, overviewQuery()).subscribe(ignore),
  ];
  try {
    await expect.poll(() => client.isFetching()).toBe(0);
    expect(
      client.getQueryData(conversationEventsQuery(client, conversationId).queryKey),
    ).toHaveLength(2);
    fake.server.requests.length = 0;
    overviewReads.length = 0;
    fake.server.events.set(conversationId, turnEvents("t-1", 1, true));
    await invalidateChanges(
      client,
      ChangeNotice.make({
        revision: 2,
        reset: false,
        changes: [{ kind: "conversation", id: conversationId }],
      }),
    );
    await expect.poll(() => client.isFetching()).toBe(0);
    expect([...fake.server.requests].sort()).toEqual(
      [
        "GET /api/conversations",
        `GET /api/conversations/${conversationId}`,
        `GET /api/conversations/${conversationId}/events?after=2`,
      ].sort(),
    );
    expect(overviewReads).toEqual([]);
    expect(
      client.getQueryData(conversationEventsQuery(client, conversationId).queryKey),
    ).toHaveLength(4);
  } finally {
    for (const unsubscribe of observed) unsubscribe();
    client.clear();
  }
});

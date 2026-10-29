import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ReadyOverview } from "@usine/orchestrator/operator";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import { PageCommandsProvider } from "~/components/command-palette/context";
import { CommandPalette } from "~/components/command-palette/palette";
import { WithRouter } from "~/lib/testing/memory-router";
import { MembersPage } from "./members.page";
import { membersQuery } from "./queries";
import "~/index.css";

it("offers enabled member actions, preserves pending states, and confirms removal", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  });
  let members = [
    { id: 1, login: "operator", addedAt: 0, addedBy: "operator" },
    { id: 2, login: "developer", addedAt: 0, addedBy: "operator" },
  ];
  client.setQueryData(membersQuery().queryKey, members);
  const requests: string[] = [];
  let finish = () => {};
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (init?.method === "GET") return Response.json(members);
    requests.push(`${init?.method} ${input}`);
    if (init?.method === "POST") {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      members = [...members, { id: 3, login: "reviewer", addedAt: 0, addedBy: "operator" }];
    } else members = members.filter(({ id }) => id !== 2);
    return Response.json({ ok: true });
  };
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    flushSync(() =>
      root.render(
        <QueryClientProvider client={client}>
          <WithRouter>
            <PageCommandsProvider>
              <CommandPalette
                overview={new ReadyOverview({ projects: [], loops: [], needsYou: [] })}
              />
              <MembersPage />
            </PageCommandsProvider>
          </WithRouter>
        </QueryClientProvider>,
      ),
    );
    const search = async (text: string) => {
      await page.getByRole("button", { name: "Open commands" }).click();
      await page.getByRole("combobox").fill(text);
    };
    await search("Add member");
    await expect
      .element(page.getByRole("option", { name: "Add member", exact: true }))
      .not.toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await page.getByLabelText("GitHub login").fill("reviewer");
    await search("Add member");
    await page.getByRole("option", { name: "Add member", exact: true }).click();
    await expect.poll(() => requests).toEqual(["POST /api/members"]);
    await search("Remove");
    await expect
      .element(page.getByRole("option", { name: "Remove · developer", exact: true }))
      .not.toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    finish();
    await expect.element(page.getByLabelText("GitHub login")).toHaveValue("");
    await search("Remove developer");
    await page.getByRole("option", { name: "Remove · developer", exact: true }).click();
    await expect.element(page.getByRole("button", { name: "Confirm removal" })).toBeVisible();
    expect(requests).toHaveLength(1);
    await page.getByRole("button", { name: "Keep member" }).click();
    await search("Remove developer");
    await page.getByRole("option", { name: "Remove · developer", exact: true }).click();
    await page.getByRole("button", { name: "Confirm removal" }).click();
    await expect.poll(() => requests).toEqual(["POST /api/members", "DELETE /api/members/2"]);
    await expect.element(page.getByText("developer", { exact: true })).not.toBeInTheDocument();
    client.setQueryData(
      membersQuery().queryKey,
      members.filter(({ id }) => id === 1),
    );
    await search("Remove operator");
    await expect
      .element(page.getByRole("option", { name: "Remove · operator", exact: true }))
      .not.toBeInTheDocument();
  } finally {
    finish();
    flushSync(() => root.unmount());
    client.clear();
    host.remove();
    globalThis.fetch = originalFetch;
  }
});

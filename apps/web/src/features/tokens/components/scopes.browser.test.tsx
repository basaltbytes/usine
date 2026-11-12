import { PermissionGrant, ProjectScope } from "@usine/core/access";
import { ProjectId } from "@usine/core/project";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { page } from "vitest/browser";
import { PermissionsContext } from "~/lib/permissions";
import { configurationQuery } from "~/lib/configuration/queries";
import { configurationFixture } from "~/lib/configuration/fixture";
import { TokenScopes } from "./scopes";
import "~/index.css";

it("offers only granted scopes and displays the new secret once", async () => {
  const grants = [
    PermissionGrant.make({
      permission: "read",
      scope: ProjectScope.make({ project: ProjectId.make("alpha") }),
    }),
  ];
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  });
  client.setQueryData(configurationQuery().queryKey, configurationFixture());
  const requests: unknown[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (_input, options) => {
    requests.push(JSON.parse(String(options?.body)));
    return Response.json({ token: "one-time-secret" });
  };
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    flushSync(() =>
      root.render(
        <QueryClientProvider client={client}>
          <PermissionsContext.Provider value={grants}>
            <TokenScopes />
          </PermissionsContext.Provider>
        </QueryClientProvider>,
      ),
    );
    await expect.element(page.getByLabelText("Instance admin")).not.toBeInTheDocument();
    await page.getByLabelText("Token name").fill("Read alpha");
    await page.getByRole("checkbox", { name: "Read · alpha" }).click();
    await page.getByRole("button", { name: "Create token" }).click();
    await expect
      .element(page.getByLabelText("Copy this token now. You cannot read it again."))
      .toHaveValue("one-time-secret");
    expect(requests).toEqual([
      {
        name: "Read alpha",
        scopes: [{ permission: "read", scope: { _tag: "Project", project: "alpha" } }],
      },
    ]);
  } finally {
    flushSync(() => root.unmount());
    client.clear();
    host.remove();
    globalThis.fetch = original;
  }
});

it("sends an operation ceiling and an expiry with a new token, and keeps or removes a ceiling on edit", async () => {
  const grants = [
    PermissionGrant.make({
      permission: "read",
      scope: ProjectScope.make({ project: ProjectId.make("alpha") }),
    }),
  ];
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  });
  client.setQueryData(configurationQuery().queryKey, configurationFixture());
  const requests: unknown[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (_input, options) => {
    requests.push(JSON.parse(String(options?.body)));
    return Response.json(options?.method === "POST" ? { token: "one-time-secret" } : { ok: true });
  };
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const token = { id: "agent", scopes: grants, operations: ["operator.overview"] };
  try {
    flushSync(() =>
      root.render(
        <QueryClientProvider client={client}>
          <PermissionsContext.Provider value={grants}>
            <TokenScopes />
            <TokenScopes token={token} />
          </PermissionsContext.Provider>
        </QueryClientProvider>,
      ),
    );
    await page.getByLabelText("Token name").fill("Agent");
    await page.getByLabelText("Operations").first().fill("operator.overview, operator.detail");
    await page.getByLabelText("Expires").fill("2027-01-02T03:04");
    await page.getByRole("button", { name: "Create token" }).click();
    await expect.poll(() => requests).toHaveLength(1);
    await page.getByRole("button", { name: "Save scopes" }).click();
    await expect.poll(() => requests).toHaveLength(2);
    await expect.element(page.getByLabelText("Operations").last()).toHaveValue("operator.overview");
    await page.getByLabelText("Operations").last().fill("");
    await page.getByRole("button", { name: "Save scopes" }).click();
    await expect.poll(() => requests).toHaveLength(3);
    const scopes = [{ permission: "read", scope: { _tag: "Project", project: "alpha" } }];
    expect(requests).toEqual([
      {
        name: "Agent",
        scopes: [],
        operations: ["operator.overview", "operator.detail"],
        expiresAt: new Date("2027-01-02T03:04").getTime(),
      },
      { scopes },
      { scopes, operations: null },
    ]);
  } finally {
    flushSync(() => root.unmount());
    client.clear();
    host.remove();
    globalThis.fetch = original;
  }
});

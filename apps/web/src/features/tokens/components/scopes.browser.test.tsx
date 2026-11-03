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

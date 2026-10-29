import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { expect, it } from "vitest";
import { commands, page } from "vitest/browser";
import { SignInPage } from "./sign-in.page";
import { signInQuery } from "./queries";
import "~/index.css";

declare module "vitest/browser" {
  interface BrowserCommands {
    signInResponses: () => Promise<void>;
  }
}

it("consumes a link opened while the sign-in page is already mounted and removes the secret from the URL", async () => {
  await commands.signInResponses();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queries.setQueryData(signInQuery().queryKey, { github: false });
  try {
    flushSync(() =>
      root.render(
        <QueryClientProvider client={queries}>
          <SignInPage error={undefined} />
        </QueryClientProvider>,
      ),
    );
    await expect.element(page.getByRole("heading", { name: "Sign in to usine" })).toBeVisible();
    window.location.hash = "link=expired-link";
    await expect
      .element(page.getByText("This sign-in link expired. Run usine sign-in-link for a new link."))
      .toBeVisible();
    expect(window.location.hash).toBe("");
  } finally {
    flushSync(() => root.unmount());
    host.remove();
    queries.clear();
  }
});

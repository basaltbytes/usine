import { TokenCount } from "@usine/core/agent/session";
import { RunUsageView } from "@usine/orchestrator/operator";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { page } from "vitest/browser";
import { PageHeader } from "~/components/page";
import { UsageFact } from "./usage";
import "~/index.css";

it("keeps the token breakdown trigger in the primary colour inside muted page facts", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const usage = RunUsageView.make({ tokens: TokenCount.make(0), pools: [], sessions: [] });
  try {
    flushSync(() =>
      root.render(
        <PageHeader
          heading={<h1>Run usage</h1>}
          actionsBeside="never"
          facts={
            <>
              <span className="text-primary">Primary colour</span>
              <span>Static fact</span>
              <UsageFact usage={usage} attempts={[]} />
            </>
          }
        />,
      ),
    );
    const trigger = page.getByRole("button", {
      name: "Tokens: 0. Show per pool and session",
      exact: true,
    });
    await expect.element(trigger).toBeVisible();
    const primary = getComputedStyle(page.getByText("Primary colour").element()).color;
    const muted = getComputedStyle(page.getByText("Static fact").element()).color;
    expect(primary).not.toBe(muted);
    expect(getComputedStyle(trigger.element()).color).toBe(primary);
  } finally {
    flushSync(() => root.unmount());
    host.remove();
  }
});

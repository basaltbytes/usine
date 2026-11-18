import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import { TextTooltip, TextTooltipProvider } from "~/components/text-tooltip";
import { tooltipText } from "~/lib/testing/tooltip";
import "~/index.css";

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
});

const openTooltip = () =>
  document.querySelector("[data-slot=tooltip-content][data-open]")?.textContent ?? null;

it("describes the element with the tooltip unless the tooltip repeats the element's text", async () => {
  flushSync(() =>
    root.render(
      <TextTooltipProvider>
        <TextTooltip text="Total attempt time">
          <span>2m</span>
        </TextTooltip>
        <TextTooltip text="A long title cut short" repeats>
          <span className="truncate">A long title cut short</span>
        </TextTooltip>
      </TextTooltipProvider>,
    ),
  );
  await expect
    .element(page.getByText("2m", { exact: true }))
    .toHaveAttribute("aria-description", "Total attempt time");
  await expect
    .element(page.getByText("A long title cut short", { exact: true }))
    .not.toHaveAttribute("aria-description");
  expect(await tooltipText(page.getByText("2m", { exact: true }))).toBe("Total attempt time");
});

it("opens on keyboard focus, and Escape closes it and still reaches the dialog around it", async () => {
  const keys: Array<string> = [];
  flushSync(() =>
    root.render(
      <TextTooltipProvider>
        <div role="dialog" aria-label="Tray" onKeyDown={(event) => keys.push(event.key)}>
          <TextTooltip text="Pull request #530, closed" repeats>
            <a href="#530" aria-label="Pull request #530, closed">
              #530
            </a>
          </TextTooltip>
        </div>
      </TextTooltipProvider>,
    ),
  );
  await userEvent.tab();
  await expect.element(page.getByRole("link", { name: "Pull request #530, closed" })).toHaveFocus();
  await expect.poll(openTooltip, { timeout: 5_000 }).toBe("Pull request #530, closed");
  await userEvent.keyboard("{Escape}");
  await expect.poll(openTooltip).toBeNull();
  expect(keys).toEqual(["Escape"]);
});

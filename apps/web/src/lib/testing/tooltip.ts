import { expect } from "vitest";
import { userEvent, type Locator } from "vitest/browser";

const openTooltip = () => document.querySelector("[data-slot=tooltip-content][data-open]");

/**
 * Hovers `trigger`, waits past the tooltip's open delay, and returns the tooltip's text. Moves the
 * pointer away and waits for the tooltip to close before it returns.
 */
export const tooltipText = async (trigger: Element | Locator): Promise<string> => {
  await userEvent.hover(trigger);
  await expect.poll(openTooltip, { timeout: 5_000 }).not.toBeNull();
  const text = openTooltip()?.textContent ?? "";
  await userEvent.unhover(trigger);
  await expect.poll(openTooltip, { timeout: 5_000 }).toBeNull();
  return text;
};

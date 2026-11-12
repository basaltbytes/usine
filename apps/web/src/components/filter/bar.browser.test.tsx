import { HardDrivesIcon, RobotIcon, TagIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import { FilterBar } from "~/components/filter/bar";
import type { AppliedFilter, FilterField } from "~/components/filter/field";
import "~/index.css";

type Field = "agent" | "worker" | "label";

const fields: readonly FilterField<Field>[] = [
  {
    id: "agent",
    label: "Agent",
    icon: RobotIcon,
    options: [
      { value: "developer", label: "developer" },
      { value: "reviewer", label: "reviewer" },
    ],
  },
  {
    id: "worker",
    label: "Worker",
    icon: HardDrivesIcon,
    options: [{ value: "local", label: "local" }],
  },
  { id: "label", label: "Label", icon: TagIcon, options: [] },
];

let host: HTMLDivElement;
let root: Root;
let changes: Array<readonly AppliedFilter<Field>[]>;

type HarnessProps = { readonly initial: readonly AppliedFilter<Field>[] };

const Harness = ({ initial }: HarnessProps) => {
  const [value, setValue] = useState(initial);
  return (
    <FilterBar
      fields={fields}
      value={value}
      onValueChange={(next) => {
        changes.push(next);
        setValue(next);
      }}
    />
  );
};

beforeEach(async () => {
  document.documentElement.classList.add("dark");
  await page.viewport(1024, 600);
  host = document.createElement("div");
  host.className = "bg-background p-4 text-foreground";
  document.body.append(host);
  root = createRoot(host);
  changes = [];
});

afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
});

const render = (initial: readonly AppliedFilter<Field>[] = []) =>
  flushSync(() => root.render(<Harness initial={initial} />));
const filterButton = () => page.getByRole("button", { name: "Filter", exact: true });
const search = (name: string) => page.getByRole("combobox", { name, exact: true });
const option = (name: string) => page.getByRole("option", { name, exact: true });
const chip = (name: string) => page.getByRole("group", { name, exact: true });

it("picks a field, then a value, from the keyboard", async () => {
  render();
  filterButton().element().focus();
  await userEvent.keyboard("{Enter}");
  await expect.element(search("Filter")).toHaveFocus();
  await expect.element(option("Agent")).toHaveAttribute("aria-selected", "true");
  await expect.element(option("Label")).not.toBeInTheDocument();
  await userEvent.keyboard("{ArrowDown}{Enter}");
  await expect.element(search("Worker")).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  await expect.element(chip("Worker is local")).toBeVisible();
  expect(changes).toEqual([[{ field: "worker", value: "local" }]]);
  await expect.element(search("Filter")).not.toBeInTheDocument();
  await expect.element(filterButton()).toHaveFocus();
});

it("finds a value by typing, without choosing a field first", async () => {
  render([{ field: "worker", value: "local" }]);
  await filterButton().click();
  await userEvent.keyboard("rev");
  await expect.element(option("Worker")).not.toBeInTheDocument();
  await expect.element(option("reviewer")).toHaveAttribute("aria-selected", "true");
  await userEvent.keyboard("{Enter}");
  await expect.element(chip("Agent is reviewer")).toBeVisible();
  expect(changes.at(-1)).toEqual([
    { field: "worker", value: "local" },
    { field: "agent", value: "reviewer" },
  ]);
});

it("opens a chip's value on the applied one, goes back with Backspace, and closes with Escape", async () => {
  render([{ field: "agent", value: "reviewer" }]);
  const value = chip("Agent is reviewer").getByRole("button", { name: "reviewer", exact: true });
  await value.click();
  await expect.element(search("Agent")).toHaveFocus();
  await expect.element(option("reviewer")).toHaveAttribute("aria-selected", "true");
  await userEvent.keyboard("{ArrowUp}{Enter}");
  await expect.element(chip("Agent is developer")).toBeVisible();
  await chip("Agent is developer").getByRole("button", { name: "developer", exact: true }).click();
  await userEvent.keyboard("{Backspace}");
  await expect.element(search("Filter")).toHaveFocus();
  await expect.element(option("Agent")).toHaveAttribute("aria-selected", "true");
  await userEvent.keyboard("{Escape}");
  await expect.element(search("Filter")).not.toBeInTheDocument();
  expect(changes).toEqual([[{ field: "agent", value: "developer" }]]);
});

it("changes a chip's field in place and removes a chip", async () => {
  render([
    { field: "agent", value: "reviewer" },
    { field: "worker", value: "local" },
  ]);
  await chip("Agent is reviewer").getByRole("button", { name: "Agent", exact: true }).click();
  await option("Worker").click();
  await option("local").click();
  expect(changes.at(-1)).toEqual([{ field: "worker", value: "local" }]);
  await chip("Worker is local").getByRole("button", { name: "Remove filter", exact: true }).click();
  expect(changes.at(-1)).toEqual([]);
  await expect.element(chip("Worker is local")).not.toBeInTheDocument();
  await expect.element(filterButton()).toHaveFocus();
});

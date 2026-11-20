import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { page } from "vitest/browser";
import type { Schema } from "effect";
import { SettingsFields } from "~/features/configuration/components/forms/settings";
import { capabilitiesQuery } from "~/lib/configuration/capabilities";
import { capabilitiesFixture } from "~/lib/configuration/fixture";
import "~/index.css";

/**
 * Renders the settings form on `{ settings: { poll_interval: 60 } }` and returns each value that it
 * emits, with the cleanup that unmounts it.
 */
const renderSettings = () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(capabilitiesQuery().queryKey, capabilitiesFixture());
  const changes: Array<Schema.JsonObject> = [];
  const Form = () => {
    const [value, setValue] = useState<Schema.JsonObject>({ settings: { poll_interval: 60 } });
    return (
      <SettingsFields
        value={value}
        onChange={(next) => {
          changes.push(next);
          setValue(next);
        }}
        problems={[]}
      />
    );
  };
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  flushSync(() =>
    root.render(
      <QueryClientProvider client={client}>
        <Form />
      </QueryClientProvider>,
    ),
  );
  return {
    changes,
    unmount: () => {
      root.unmount();
      host.remove();
    },
  };
};

it("writes the supervisor's brain under settings.supervisor and removes it when unchecked", async () => {
  const { changes, unmount } = renderSettings();
  try {
    const supervisor = page.getByRole("checkbox", { name: "Run a supervisor", exact: true });
    await supervisor.click();
    await expect.element(supervisor).toBeChecked();
    expect(changes).toHaveLength(1);
    expect(changes[0]).toStrictEqual({
      settings: {
        poll_interval: 60,
        supervisor: { harness: "", model: "", effort: "medium" },
      },
    });

    await page
      .getByRole("combobox", { name: "Supervisor harness", exact: true })
      .selectOptions("claude");
    await page
      .getByRole("textbox", { name: "Supervisor model", exact: true })
      .fill("claude-sonnet-5-5");
    expect(changes.at(-1)).toStrictEqual({
      settings: {
        poll_interval: 60,
        supervisor: { harness: "claude", model: "claude-sonnet-5-5", effort: "medium" },
      },
    });

    await supervisor.click();
    await expect.element(supervisor).not.toBeChecked();
    await expect
      .element(page.getByRole("textbox", { name: "Supervisor model", exact: true }))
      .not.toBeInTheDocument();
    expect(changes.at(-1)).toStrictEqual({ settings: { poll_interval: 60 } });
  } finally {
    unmount();
  }
});

it("writes settings.allow_usage_credits when checked and removes it when unchecked", async () => {
  const { changes, unmount } = renderSettings();
  try {
    const credits = page.getByRole("checkbox", { name: /^Allow usage credits/ });
    await expect.element(credits).not.toBeChecked();
    await credits.click();
    await expect.element(credits).toBeChecked();
    expect(changes.at(-1)).toStrictEqual({
      settings: { poll_interval: 60, allow_usage_credits: true },
    });
    await credits.click();
    await expect.element(credits).not.toBeChecked();
    expect(changes.at(-1)).toStrictEqual({ settings: { poll_interval: 60 } });
  } finally {
    unmount();
  }
});

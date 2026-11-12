import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { page } from "vitest/browser";
import type { Schema } from "effect";
import { AgentFields } from "~/features/configuration/components/forms/agent";
import { capabilitiesQuery } from "~/lib/configuration/capabilities";
import { capabilitiesFixture, configurationFixture } from "~/lib/configuration/fixture";
import { configurationQuery } from "~/lib/configuration/queries";
import "~/index.css";

it("clears an Agent's coordinator override when the Coordinator is left blank", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(capabilitiesQuery().queryKey, capabilitiesFixture());
  client.setQueryData(configurationQuery().queryKey, configurationFixture());
  const changes: Array<Schema.JsonObject> = [];
  const Form = () => {
    const [value, setValue] = useState<Schema.JsonObject>({
      name: "triager",
      harness: "codex",
      model: "gpt-5.6-sol",
      effort: "high",
      coordinator: "events",
      persona: "Triage the issue.",
    });
    return (
      <AgentFields
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
  try {
    flushSync(() =>
      root.render(
        <QueryClientProvider client={client}>
          <Form />
        </QueryClientProvider>,
      ),
    );
    const coordinator = page.getByRole("combobox", { name: "Coordinator", exact: true });
    await expect.element(coordinator).toHaveValue("events");
    await coordinator.selectOptions("");
    await expect.element(coordinator).toHaveValue("");
    expect(changes).toHaveLength(1);
    expect(changes[0]).not.toHaveProperty("coordinator");
    expect(changes[0]).toMatchObject({ name: "triager", harness: "codex", effort: "high" });
  } finally {
    root.unmount();
    host.remove();
  }
});

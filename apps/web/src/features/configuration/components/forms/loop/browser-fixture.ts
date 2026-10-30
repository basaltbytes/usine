import type { Page } from "playwright";
import { Schema } from "effect";

export const loopEditorResponses = async (
  { page }: { readonly page: Page },
  configuration: string,
  resumeRejections: readonly { readonly status: number; readonly body: string }[] = [],
) => {
  const { ConfigurationView } = await import("@usine/orchestrator/operator");
  const current = Schema.decodeUnknownSync(ConfigurationView)(JSON.parse(configuration));
  let saved = false;
  let paused = true;
  let value: Schema.JsonObject = {
    name: "usine/draft-loop",
    trigger: { on: "issue", if: "true" },
    selector: { _tag: "None" },
    priority: { _tag: "None" },
    approval: "none",
    step: "run",
    agent: "developer",
    maxCycles: 3,
    permissions: "write",
    body: "Implement {{ item.title }}.",
  };
  const text =
    '---\ntrigger: { on: issue, if: "true" }\nagent: developer\n---\nImplement {{ item.title }}.';
  await page.route("**/api/configuration/entities/loop/usine%2Fdraft-loop", async (route) => {
    if (route.request().method() === "PUT") {
      const body = Schema.decodeUnknownSync(Schema.Struct({ value: Schema.JsonObject }))(
        route.request().postDataJSON(),
      );
      value = body.value;
      saved = true;
      await route.fallback();
    } else
      await route.fulfill({
        status: saved ? 200 : 404,
        contentType: "application/json",
        body: JSON.stringify(
          saved
            ? { key: { kind: "loop", identifier: "usine/draft-loop" }, value, text, number: 3 }
            : { error: "ConfigurationNotFound", message: "Entity not found" },
        ),
      });
  });
  await page.route("**/api/configuration", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ...Schema.encodeSync(ConfigurationView)(current),
        loops: saved
          ? [
              ...current.loops,
              {
                ...current.loops[0],
                name: "usine/draft-loop",
                file: "loops/draft-loop.md",
                paused,
              },
            ]
          : current.loops,
      }),
    }),
  );
  await page.route("**/api/configuration/loops/check", async (route) => {
    const draft = Schema.decodeUnknownSync(Schema.Struct({ value: Schema.JsonObject }))(
      route.request().postDataJSON(),
    );
    const trigger = Schema.decodeUnknownSync(Schema.Struct({ if: Schema.String }))(
      draft.value.trigger,
    );
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        problems: trigger.if.includes("unknown")
          ? [
              {
                path: ["trigger", "if"],
                message: "Unknown field: unknown",
                expression: trigger.if,
                position: 5,
              },
            ]
          : [],
      }),
    });
  });
  await page.route("**/api/configuration/loops/preview", async (route) => {
    const draft = Schema.decodeUnknownSync(
      Schema.Struct({ itemKey: Schema.optionalKey(Schema.String) }),
    )(route.request().postDataJSON());
    const number = draft.itemKey?.endsWith("#2") ? 2 : 1;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        stream: "issue",
        total: 2,
        items: [1, 2].map((number) => ({
          itemKey: `github:basaltbytes/usine#${number}`,
          repository: "basaltbytes/usine",
          kind: "issue",
          number,
          title: `Fix issue ${number}`,
          url: `https://github.com/basaltbytes/usine/issues/${number}`,
          state: "issue-open",
          priority: -1,
        })),
        prompt: {
          itemKey: `github:basaltbytes/usine#${number}`,
          text: `Implement Fix issue ${number}.`,
        },
        failures: [],
        repositoriesWithoutItems: [],
      }),
    });
  });
  let resumeRequests = 0;
  await page.route("**/api/loops/usine%2Fdraft-loop/unpause", async (route) => {
    const rejection = resumeRejections[resumeRequests++];
    if (rejection !== undefined) {
      await route.fulfill({ ...rejection, contentType: "application/json" });
      return;
    }
    paused = false;
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });
};

import { RoleBinding } from "@usine/core/access";
import { ConfigurationView } from "@usine/orchestrator/operator";
import { writeYaml } from "@usine/config/yaml/writer";
import { Schema } from "effect";
import type { Page } from "playwright";

export const bindingEditorResponses = async (
  { page }: { readonly page: Page },
  configuration: string,
) => {
  const initial = Schema.decodeUnknownSync(ConfigurationView)(JSON.parse(configuration));
  const bindings = new Map(initial.bindings.map((binding) => [binding.name, binding]));
  const revisions: Schema.JsonObject[] = [];
  let number = 1;
  let refuse = true;
  await page.route("**/api/configuration", (route) =>
    route.fulfill({
      json: Schema.encodeSync(ConfigurationView)(
        ConfigurationView.make({ ...initial, bindings: [...bindings.values()] }),
      ),
    }),
  );
  await page.route("**/api/configuration/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const identifier = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
    if (identifier === "head") return route.fulfill({ json: { number } });
    if (identifier === "revisions")
      return route.fulfill({ json: { revisions: [...revisions].reverse(), nextBefore: null } });
    if (url.pathname.includes("/revisions/"))
      return route.fulfill({
        json: revisions.find((revision) => revision.number === Number(identifier)),
      });
    const key = { kind: "binding", identifier };
    const previous = bindings.get(identifier);
    if (request.method() === "GET")
      return previous === undefined
        ? route.fulfill({
            status: 404,
            json: { error: "ConfigurationNotFound", message: "Binding not found" },
          })
        : route.fulfill({
            json: {
              key,
              number,
              value: Schema.encodeSync(RoleBinding)(previous),
              text: writeYaml(Schema.encodeSync(RoleBinding)(previous)),
            },
          });
    const payload = Schema.decodeUnknownSync(Schema.JsonObject)(request.postDataJSON());
    if (refuse && request.method() === "PUT") {
      refuse = false;
      return route.fulfill({
        status: 422,
        json: {
          error: "ConfigurationInvalid",
          message: "The configuration is invalid.",
          problems: [
            {
              entity: key,
              path: ["member"],
              message: "This member was removed. Choose another member.",
            },
          ],
        },
      });
    }
    const next =
      request.method() === "DELETE" ? null : Schema.decodeUnknownSync(RoleBinding)(payload.value);
    if (next === null) bindings.delete(identifier);
    else bindings.set(identifier, next);
    const revision = {
      number: ++number,
      actor: "alice-admin",
      time: "2026-11-04T10:00:00.000Z",
      message: payload.message ?? "",
      entities: [key],
      changes: [
        {
          key,
          before: previous === undefined ? null : Schema.encodeSync(RoleBinding)(previous),
          after: next === null ? null : Schema.encodeSync(RoleBinding)(next),
        },
      ],
    };
    revisions.push(revision);
    return route.fulfill({ json: revision });
  });
};

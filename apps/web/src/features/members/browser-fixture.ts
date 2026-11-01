import type { Page } from "playwright";

export const accessResponses = async (
  { page }: { readonly page: Page },
  configuration: string,
  permissions: string,
) => {
  await page.route("**/api/auth/session", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: `{"permissions":${permissions}}`,
    }),
  );
  await page.route("**/api/members", (route) =>
    route.fulfill({
      json: [
        { id: 1, login: "alice-admin", addedAt: 1793520000000, addedBy: "local admin" },
        { id: 2, login: "olivia-operator", addedAt: 1793520000000, addedBy: "alice-admin" },
        { id: 3, login: "victor-viewer", addedAt: 1793520000000, addedBy: "alice-admin" },
        { id: 4, login: "new-member", addedAt: 1793520000000, addedBy: "alice-admin" },
      ],
    }),
  );
  await page.route("**/api/tokens", (route) =>
    route.fulfill({
      json: [
        {
          id: "browser",
          name: "Browser session",
          createdAt: 1793520000000,
          lastUsedAt: 1793523600000,
          kind: "browser",
          scopes: [{ permission: "admin", scope: { _tag: "Instance" } }],
        },
      ],
    }),
  );
  await page.route("**/api/configuration", (route) =>
    route.fulfill({ contentType: "application/json", body: configuration }),
  );
  await page.route("**/api/configuration/revisions*", (route) =>
    route.fulfill({ json: { revisions: [], nextBefore: null } }),
  );
  await page.route("**/api/configuration/entities/binding/*", (route) => {
    const name = new URL(route.request().url()).pathname.split("/").at(-1);
    const bindings = [
      { name: "instance-admin", member: 1, role: "admin", scope: { _tag: "Instance" } },
      {
        name: "project-operator",
        member: 2,
        role: "operator",
        scope: { _tag: "Project", project: "usine" },
      },
      {
        name: "project-viewer",
        member: 3,
        role: "viewer",
        scope: { _tag: "Project", project: "usine" },
      },
    ];
    const value = bindings.find((binding) => binding.name === name);
    return route.fulfill({
      json: {
        key: { kind: "binding", identifier: name },
        number: 1,
        value,
        text:
          value === undefined
            ? ""
            : `name: ${value.name}\nmember: ${value.member}\nrole: ${value.role}\nscope:\n  _tag: ${value.scope._tag}\n${value.scope.project === undefined ? "" : `  project: ${value.scope.project}\n`}`,
      },
    });
  });
};

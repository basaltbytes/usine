import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { Page } from "playwright";

interface WriteRequest {
  readonly method: string;
  readonly url: string;
  readonly payload: unknown;
}
const requests = new WeakMap<Page, WriteRequest[]>();

export const configurationEditorRequests = ({ page }: { readonly page: Page }) =>
  requests.get(page) ?? [];

export const configurationEditorResponses = async (
  { page }: { readonly page: Page },
  rejections: readonly { readonly status: number; readonly body: string }[],
  configuration: string,
) => {
  await page.route("**/api/overview", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ _tag: "Ready", projects: [], loops: [], needsYou: [] }),
    }),
  );
  await page.route("**/api/upgrade", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        running: "1.0.0",
        channel: "latest",
        mode: "off",
        supported: false,
        available: null,
        phase: "idle",
        message: null,
        outcome: null,
      }),
    }),
  );
  const writes: WriteRequest[] = [];
  requests.set(page, writes);
  let number = 2;
  let text = "name: local\nkind: local\nmax_concurrent_attempts: 2\n";
  let exists = true;
  const key = { kind: "worker", identifier: "local" };
  const revision = (number: number) => ({
    number,
    actor: "operator",
    time: "2026-10-28T10:00:00.000Z",
    message: "Increase worker slots",
    entities: [key],
    changes: [
      {
        key,
        before: { name: "local", kind: "local", max_concurrent_attempts: 1 },
        after: { name: "local", kind: "local", max_concurrent_attempts: 2 },
      },
    ],
  });
  await page.route("**/api/configuration", (route) =>
    route.fulfill({ contentType: "application/json", body: configuration }),
  );
  await page.route("**/api/configuration/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const parts = url.pathname.split("/");
    const last = decodeURIComponent(parts.at(-1) ?? "");
    if (request.method() !== "GET") {
      writes.push({ method: request.method(), url: url.pathname, payload: request.postDataJSON() });
      const refusal = rejections[writes.length - 1];
      if (refusal !== undefined) {
        if (refusal.status === 409) {
          number++;
          text = "name: local\nkind: local\nmax_concurrent_attempts: 4\n";
        }
        await route.fulfill({
          status: refusal.status,
          contentType: "application/json",
          body: refusal.body,
        });
        return;
      }
      number++;
      if (request.method() === "DELETE") exists = false;
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(revision(number)),
      });
      return;
    }
    if (last === "revisions") {
      const before = url.searchParams.get("before");
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          revisions: [revision(before === null ? number : 1)],
          nextBefore: before === null ? 2 : null,
        }),
      });
      return;
    }
    if (parts.includes("revisions")) {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(revision(Number(last))),
      });
      return;
    }
    const kind = parts.at(-2);
    const known = [
      "instance",
      "local",
      "start-dev",
      "developer",
      "basaltbytes/usine",
      "ready",
    ].includes(last);
    if (!known || (last === "local" && !exists)) {
      await route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({ error: "ConfigurationNotFound", message: "Entity not found" }),
      });
      return;
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        key: { kind, identifier: last },
        value: {},
        text: last === "instance" ? "settings: {}\n" : text,
        number,
      }),
    });
  });
};

export const configurationEditorScreenshot = async (
  { page }: { readonly page: Page },
  name: string,
) => {
  await mkdir(resolve("../../.impeccable/review"), { recursive: true });
  await page.screenshot({ path: resolve(`../../.impeccable/review/${name}.png`), fullPage: true });
};

import { Schema } from "effect";
import type { Page } from "playwright";

export const configurationHistoryResponses = async (
  { page }: { readonly page: Page },
  json: string,
) => {
  const { ConfigurationRevisionView } = await import("@usine/orchestrator/operator/http");
  const codec = Schema.toCodecJson(ConfigurationRevisionView);
  const revisions = Schema.decodeSync(Schema.fromJsonString(Schema.Array(codec)))(json);
  await page.route("**/api/configuration/revisions**", (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const url = new URL(route.request().url());
    if (url.pathname !== "/api/configuration/revisions") {
      const revision = revisions.find(
        ({ number }) => number === Number(url.pathname.split("/").at(-1)),
      );
      return route.fulfill({
        json: revision === undefined ? null : Schema.encodeSync(codec)(revision),
      });
    }
    const kind = url.searchParams.get("kind");
    const identifier = url.searchParams.get("identifier");
    const before = Number(url.searchParams.get("before") ?? Infinity);
    const limit = Number(url.searchParams.get("limit") ?? 50);
    const selected = revisions.filter(
      (revision) =>
        revision.number < before &&
        (kind === null ||
          revision.entities.some((key) => key.kind === kind && key.identifier === identifier)),
    );
    return route.fulfill({
      json: {
        revisions: selected.slice(0, limit).map((revision) => Schema.encodeSync(codec)(revision)),
        nextBefore: selected.length > limit ? (selected[limit - 1]?.number ?? null) : null,
      },
    });
  });
};

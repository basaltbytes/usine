import type { Page, Route } from "playwright";

interface Exchange {
  configuration: string;
  readonly request: Promise<Route>;
}
const exchanges = new WeakMap<Page, Exchange>();

export const workerPreflightResponses = async (
  { page }: { readonly page: Page },
  configuration: string,
) => {
  await page.unroute("**/api/configuration");
  await page.unroute("**/api/workers/*/preflight");
  let receive: (route: Route) => void;
  const exchange: Exchange = {
    configuration,
    request: new Promise<Route>((resolve) => {
      receive = resolve;
    }),
  };
  exchanges.set(page, exchange);
  await page.route("**/api/configuration", (route) =>
    route.fulfill({ contentType: "application/json", body: exchange.configuration }),
  );
  await page.route("**/api/workers/*/preflight", (route) => receive(route));
};

export const finishWorkerPreflight = async (
  { page }: { readonly page: Page },
  configuration: string,
  body: string,
  status = 200,
) => {
  const exchange = exchanges.get(page);
  if (exchange === undefined) throw new Error("No preflight response configured");
  const request = await exchange.request;
  exchange.configuration = configuration;
  await request.fulfill({ status, contentType: "application/json", body });
  return { method: request.request().method(), path: new URL(request.request().url()).pathname };
};

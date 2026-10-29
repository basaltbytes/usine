import type { Page } from "playwright";
export const signInResponses = async ({ page }: { readonly page: Page }) => {
  await page.route("**/api/auth/info", (route) => route.fulfill({ json: { github: false } }));
  await page.route("**/api/auth/link/consume", (route) =>
    route.fulfill({
      status: 401,
      json: { message: "This sign-in link expired. Run usine sign-in-link for a new link." },
    }),
  );
};

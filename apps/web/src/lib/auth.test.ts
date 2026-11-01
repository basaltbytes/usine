import { Schema } from "effect";
import { expect, it, vi } from "vitest";
import { authRequest } from "./auth";

it("redirects an expired session to sign-in before protected page queries load", async () => {
  const redirects: string[] = [];
  vi.stubGlobal("window", { location: { replace: (path: string) => redirects.push(path) } });
  vi.stubGlobal("document", { cookie: "" });
  vi.stubGlobal("fetch", async () =>
    Response.json({ message: "Sign in to continue." }, { status: 401 }),
  );
  try {
    await expect(authRequest("/api/auth/session", Schema.Unknown)).rejects.toThrow(
      "Sign in to continue.",
    );
    expect(redirects).toEqual(["/sign-in"]);
  } finally {
    vi.unstubAllGlobals();
  }
});

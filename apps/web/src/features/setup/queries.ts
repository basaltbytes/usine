import { activationFailed } from "./strings";
import { SetupState } from "@usine/orchestrator/operator";
import { queryOptions } from "@tanstack/react-query";
import { Schema } from "effect";
import { authRequest, Acknowledged } from "~/lib/auth";

export const setupQuery = () =>
  queryOptions({
    queryKey: ["setup"],
    queryFn: () => authRequest("/api/setup", SetupState),
    retry: 3,
    retryDelay: 1000,
  });
export const prepareManifest = (name: string, organization: string) =>
  authRequest(
    "/api/setup/manifest",
    Schema.Struct({ action: Schema.String, manifest: Schema.String }),
    { method: "POST", body: organization === "" ? { name } : { name, organization } },
  );

export const activateInstance = async () => {
  await authRequest("/api/setup/activate", Acknowledged, { method: "POST" });
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const ready = await authRequest(
      "/api/setup/runtime",
      Schema.Struct({ ready: Schema.Boolean }),
    ).then(
      (result) => result.ready,
      () => false,
    );
    if (ready) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(activationFailed);
};

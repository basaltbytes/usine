import { SetupState } from "@usine/orchestrator/operator";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api";
import { AuthenticationError } from "../auth/api.ts";
import { AuthError } from "../auth/model.ts";
import { ManifestRequest, RestoreRequest } from "./model.ts";

const acknowledged = Schema.Struct({ ok: Schema.Literal(true) });
const error = AuthError.fields.status.literals.map((status) =>
  AuthenticationError.annotate({ httpApiStatus: status, description: "Setup operation failed." }),
);

export const SetupApi = HttpApiGroup.make("setup")
  .annotate(OpenApi.Title, "GitHub App setup")
  .add(
    HttpApiEndpoint.get("status", "/api/setup", { success: SetupState, error })
      .annotate(OpenApi.Summary, "Read setup progress")
      .annotate(
        OpenApi.Description,
        "Checks App credentials, installation, sign-in, and registry state.",
      ),
    HttpApiEndpoint.post("manifest", "/api/setup/manifest", {
      payload: ManifestRequest,
      success: Schema.Struct({ action: Schema.String, manifest: Schema.String }),
      error,
    })
      .annotate(OpenApi.Summary, "Prepare GitHub App creation")
      .annotate(
        OpenApi.Description,
        "Returns a GitHub form action and manifest, and sets a ten-minute state cookie. POST the manifest to the returned action in the same browser.",
      ),
    HttpApiEndpoint.get("callback", "/api/setup/callback", {
      query: Schema.Struct({ state: Schema.String, code: Schema.String }),
      success: HttpApiSchema.Empty(302),
    })
      .annotate(OpenApi.Summary, "Complete GitHub App creation")
      .annotate(
        OpenApi.Description,
        "Verifies the single-use state and browser cookie, exchanges GitHub's code, and saves credentials. Redirects to setup on success or failure.",
      ),
    HttpApiEndpoint.post("restore", "/api/setup/restore", {
      payload: RestoreRequest,
      success: acknowledged,
      error,
    })
      .annotate(OpenApi.Summary, "Restore App credentials")
      .annotate(
        OpenApi.Description,
        "Saves credential JSON with mode 0600 when usable credentials are missing. Accepts legacy App ID and private key files with optional client and webhook fields.",
      ),
    HttpApiEndpoint.post("activate", "/api/setup/activate", { success: acknowledged, error })
      .annotate(OpenApi.Summary, "Activate the configured instance")
      .annotate(
        OpenApi.Description,
        "Starts the runtime with saved credentials. Poll the runtime endpoint before navigating while the HTTP listener restarts.",
      ),
    HttpApiEndpoint.get("runtime", "/api/setup/runtime", {
      success: Schema.Struct({ ready: Schema.Boolean }),
      error,
    })
      .annotate(OpenApi.Summary, "Check runtime readiness")
      .annotate(OpenApi.Description, "Returns true when the instance serves the active runtime."),
  );

import { SqliteReaderState } from "@usine/engine/local-sqlite";
import { PermissionGrant } from "@usine/core/access";
import { OperatorLogin } from "@usine/core/operator";
import { Schema, Struct } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api";
import { AuthError, GitHubUserId, InstanceToken, Member, TokenId, TokenName } from "./model.ts";

export const publicAuthPaths = new Set([
  "/api/health",
  "/api/auth/github",
  "/api/auth/callback",
  "/api/auth/device",
  "/api/auth/device/poll",
  "/api/auth/link/consume",
  "/api/auth/info",
]);

export const ConsumeLink = Schema.Struct({ token: Schema.NonEmptyString });
export const StartDevice = Schema.Struct({ name: TokenName });
export const PollDevice = Schema.Struct({ id: Schema.NonEmptyString });
export const AddMember = Schema.Struct({ login: OperatorLogin });
const acknowledged = Schema.Struct({ ok: Schema.Literal(true) }).annotate({
  description: "The request completed successfully.",
});
export const AuthenticationError = Schema.Struct({
  error: Schema.Literal("AuthenticationError"),
  message: Schema.String,
});
const error = AuthError.fields.status.literals.map((status) =>
  AuthenticationError.annotate({
    httpApiStatus: status,
    description: "Sign-in or credential operation failed.",
  }),
);

export const TokenScopes = Schema.Struct({ scopes: Schema.Array(PermissionGrant) });
export const CreateToken = Schema.Struct({ name: TokenName, ...TokenScopes.fields });

export const AuthApi = HttpApiGroup.make("authentication")
  .annotate(OpenApi.Title, "Sign-in and members")
  .annotate(
    OpenApi.Description,
    "GitHub sign-in, browser sessions, instance tokens, and membership.",
  )
  .add(
    HttpApiEndpoint.get("health", "/api/health", {
      success: Schema.Struct({
        ok: Schema.Literal(true),
        sqliteReader: Schema.optionalKey(SqliteReaderState),
      }),
    })
      .annotate(OpenApi.Summary, "Check server health")
      .annotate(
        OpenApi.Description,
        "Public liveness check with the SQLite reader state; does not require instance setup.",
      ),
    HttpApiEndpoint.get("info", "/api/auth/info", {
      success: Schema.Struct({ github: Schema.Boolean }),
    })
      .annotate(OpenApi.Summary, "Read sign-in availability")
      .annotate(OpenApi.Description, "Reports whether GitHub sign-in is configured."),
    HttpApiEndpoint.get("session", "/api/auth/session", {
      success: Schema.Struct({
        member: Schema.NullOr(Member),
        permissions: Schema.Array(PermissionGrant),
        csrf: Schema.String,
      }),
      error,
    })
      .annotate(OpenApi.Summary, "Read the current session")
      .annotate(
        OpenApi.Description,
        "Returns the signed-in member and CSRF token. Setup sessions have a null member.",
      ),
    HttpApiEndpoint.post("link", "/api/auth/link", {
      success: Schema.Struct({ url: Schema.String }),
      error,
    })
      .annotate(OpenApi.Summary, "Create a sign-in link")
      .annotate(
        OpenApi.Description,
        "Requires the local admin bearer token. Returns a single-use link valid for ten minutes.",
      ),
    HttpApiEndpoint.post("consumeLink", "/api/auth/link/consume", {
      payload: ConsumeLink,
      success: Schema.Struct({ ok: Schema.Literal(true), bootstrap: Schema.Boolean }),
      error,
    })
      .annotate(OpenApi.Summary, "Consume a sign-in link")
      .annotate(
        OpenApi.Description,
        "Consumes the one-time token and sets browser session and CSRF cookies.",
      ),
    HttpApiEndpoint.get("github", "/api/auth/github", { success: HttpApiSchema.Empty(302), error })
      .annotate(OpenApi.Summary, "Start GitHub web sign-in")
      .annotate(
        OpenApi.Description,
        "Redirects to GitHub and sets a short-lived state cookie. First enrollment requires a setup session.",
      ),
    HttpApiEndpoint.get("callback", "/api/auth/callback", {
      query: Schema.Struct({ state: Schema.String, code: Schema.String }),
      success: HttpApiSchema.Empty(302),
    })
      .annotate(OpenApi.Summary, "Complete GitHub web sign-in")
      .annotate(
        OpenApi.Description,
        "Verifies state against the browser cookie, sets a session, and redirects to the UI. Failed sign-ins redirect to the sign-in page.",
      ),
    HttpApiEndpoint.post("device", "/api/auth/device", {
      payload: StartDevice,
      success: Schema.Struct({
        id: Schema.String,
        userCode: Schema.String,
        verificationUri: Schema.String,
        interval: Schema.Finite,
      }),
      error,
    })
      .annotate(OpenApi.Summary, "Start device sign-in")
      .annotate(
        OpenApi.Description,
        "Returns a challenge, GitHub user code, verification URL, and polling interval in seconds.",
      ),
    HttpApiEndpoint.post("pollDevice", "/api/auth/device/poll", {
      payload: PollDevice,
      success: Schema.Union([
        Schema.Struct({ pending: Schema.Literal(true) }),
        Schema.Struct({ token: Schema.String }),
      ]),
      error,
    })
      .annotate(OpenApi.Summary, "Poll device sign-in")
      .annotate(
        OpenApi.Description,
        "Returns pending until authorization completes, then returns the instance token once. Honor the polling interval.",
      ),
    HttpApiEndpoint.post("signOut", "/api/auth/sign-out", { success: acknowledged, error })
      .annotate(OpenApi.Summary, "Sign out")
      .annotate(OpenApi.Description, "Revokes the current credential and expires browser cookies."),
    HttpApiEndpoint.get("members", "/api/members", { success: Schema.Array(Member), error })
      .annotate(OpenApi.Summary, "List members")
      .annotate(
        OpenApi.Description,
        "Returns enrolled members. Requires a member session or token.",
      ),
    HttpApiEndpoint.post("addMember", "/api/members", {
      payload: AddMember,
      success: acknowledged,
      error,
    })
      .annotate(OpenApi.Summary, "Add a member")
      .annotate(
        OpenApi.Description,
        "Resolves the GitHub login to a numeric identity and enrolls the member.",
      ),
    HttpApiEndpoint.delete("removeMember", "/api/members/:id", {
      params: { id: Schema.FiniteFromString.pipe(Schema.decodeTo(GitHubUserId)) },
      success: acknowledged,
      error,
    })
      .annotate(OpenApi.Summary, "Remove a member")
      .annotate(
        OpenApi.Description,
        "Revokes the member credentials and removes membership. The last member cannot be removed.",
      ),
    HttpApiEndpoint.get("tokens", "/api/tokens", {
      success: Schema.Array(
        Schema.Struct(
          Struct.pick(InstanceToken.fields, [
            "id",
            "name",
            "createdAt",
            "lastUsedAt",
            "kind",
            "scopes",
          ]),
        ),
      ),
      error,
    })
      .annotate(OpenApi.Summary, "List member tokens")
      .annotate(
        OpenApi.Description,
        "Returns the current member devices and browser sessions, excluding expired credentials and token secrets.",
      ),
    HttpApiEndpoint.post("createToken", "/api/tokens", {
      payload: CreateToken,
      success: Schema.Struct({ token: Schema.String }),
      error,
    })
      .annotate(OpenApi.Summary, "Create a scoped token")
      .annotate(
        OpenApi.Description,
        "Creates a token whose scopes are a subset of the caller's effective permissions. The secret is returned once.",
      ),
    HttpApiEndpoint.put("setScopes", "/api/tokens/:id/scopes", {
      params: { id: TokenId },
      payload: TokenScopes,
      success: acknowledged,
      error,
    })
      .annotate(OpenApi.Summary, "Set token scopes")
      .annotate(
        OpenApi.Description,
        "Sets the scope ceiling for one of the member's device tokens. Requests also check current role bindings. Browser sessions follow role bindings and reject scope edits.",
      ),
    HttpApiEndpoint.delete("revokeToken", "/api/tokens/:id", {
      params: { id: TokenId },
      success: acknowledged,
      error,
    })
      .annotate(OpenApi.Summary, "Revoke a token")
      .annotate(
        OpenApi.Description,
        "Revokes a device or browser session belonging to the current member.",
      ),
  );

/** Credential requirements for every sign-in and member endpoint. */
export const authPermissions = {
  health: "public",
  info: "public",
  consumeLink: "public",
  github: "public",
  callback: "public",
  device: "public",
  pollDevice: "public",
  session: "session",
  signOut: "session",
  link: "local",
  members: "admin",
  addMember: "admin",
  removeMember: "admin",
  tokens: "tokens",
  createToken: "tokens",
  setScopes: "tokens",
  revokeToken: "tokens",
} as const satisfies Record<
  keyof typeof AuthApi.endpoints,
  "public" | "session" | "local" | "admin" | "tokens"
>;

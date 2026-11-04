import { OperatorLogin } from "@usine/core/operator";
import { AppId, RedactedPrivateKey } from "@usine/github/github-app";
import { Schema } from "effect";

export const ManifestRequest = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(34)),
  organization: Schema.OptionFromOptionalKey(OperatorLogin),
});

export const ManifestResponse = Schema.Struct({
  appId: AppId,
  privateKey: RedactedPrivateKey,
  clientId: Schema.NonEmptyString,
  clientSecret: Schema.RedactedFromValue(Schema.NonEmptyString),
  webhookSecret: Schema.RedactedFromValue(Schema.NonEmptyString),
}).pipe(
  Schema.encodeKeys({
    appId: "id",
    privateKey: "pem",
    clientId: "client_id",
    clientSecret: "client_secret",
    webhookSecret: "webhook_secret",
  }),
);

export const RestoreRequest = Schema.Struct({ credentials: Schema.NonEmptyString });

/** The GitHub App manifest submitted by the setup form. */
export const AppManifest = Schema.Struct({
  name: ManifestRequest.fields.name,
  url: Schema.String,
  public: Schema.Literal(false),
  redirect_url: Schema.String,
  callback_urls: Schema.Array(Schema.String),
  setup_url: Schema.String,
  hook_attributes: Schema.Struct({ active: Schema.Literal(true), url: Schema.String }),
  default_permissions: Schema.Record(Schema.String, Schema.Literals(["read", "write"])),
  default_events: Schema.Array(Schema.String),
});

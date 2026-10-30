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

import { PermissionGrant } from "@usine/core/access";
import { queryOptions } from "@tanstack/react-query";
import { Effect, Schema } from "effect";
import { authRequest } from "~/lib/auth";
const Token = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  createdAt: Schema.Number,
  lastUsedAt: Schema.Number,
  kind: Schema.String,
  scopes: Schema.Array(PermissionGrant).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
});
export const tokensQuery = () =>
  queryOptions({
    queryKey: ["tokens"],
    queryFn: () => authRequest("/api/tokens", Schema.Array(Token)),
  });

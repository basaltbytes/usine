import { queryOptions } from "@tanstack/react-query";
import { Schema } from "effect";
import { authRequest } from "~/lib/auth";
const Token = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  createdAt: Schema.Number,
  lastUsedAt: Schema.Number,
  kind: Schema.String,
});
export const tokensQuery = () =>
  queryOptions({
    queryKey: ["tokens"],
    queryFn: () => authRequest("/api/tokens", Schema.Array(Token)),
  });

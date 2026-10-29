import { queryOptions } from "@tanstack/react-query";
import { Schema } from "effect";
import { authRequest } from "~/lib/auth";
const Member = Schema.Struct({
  id: Schema.Number,
  login: Schema.String,
  addedAt: Schema.Number,
  addedBy: Schema.String,
});
export const membersQuery = () =>
  queryOptions({
    queryKey: ["members"],
    queryFn: () => authRequest("/api/members", Schema.Array(Member)),
  });

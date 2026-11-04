import { queryOptions } from "@tanstack/react-query";
import { GitHubUserId } from "@usine/core/access";
import { Schema } from "effect";
import { authRequest } from "~/lib/auth";
const Member = Schema.Struct({
  id: GitHubUserId,
  login: Schema.String,
  addedAt: Schema.Finite,
  addedBy: Schema.String,
});
export const membersQuery = () =>
  queryOptions({
    queryKey: ["members"],
    queryFn: () => authRequest("/api/members", Schema.Array(Member)),
  });

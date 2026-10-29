import { queryOptions } from "@tanstack/react-query";
import { Schema } from "effect";
import { authRequest } from "~/lib/auth";
export const signInQuery = () =>
  queryOptions({
    queryKey: ["sign-in"],
    queryFn: () => authRequest("/api/auth/info", Schema.Struct({ github: Schema.Boolean })),
  });

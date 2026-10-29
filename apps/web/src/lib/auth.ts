import { Schema } from "effect";

const Failure = Schema.Struct({ message: Schema.String });
export const csrfToken = () =>
  document.cookie
    .split("; ")
    .find((cookie) => cookie.startsWith("usine_csrf="))
    ?.slice("usine_csrf=".length) ?? "";

export interface AuthRequestOptions {
  readonly method?: string;
  body?: Readonly<Record<string, string>>;
}

export const authRequest = async <A, I>(
  path: string,
  schema: Schema.Codec<A, I>,
  options: AuthRequestOptions = {},
): Promise<A> => {
  const init: RequestInit = {
    method: options.method ?? "GET",
    credentials: "same-origin",
    headers: { "content-type": "application/json", "x-usine-csrf": csrfToken() },
  };
  if (options.body !== undefined) init.body = JSON.stringify(options.body);
  const response = await fetch(path, init);
  if (response.status === 401 && !path.startsWith("/api/auth/"))
    window.location.replace("/sign-in");
  const value: unknown = await response.json();
  if (!response.ok) throw new Error(Schema.decodeUnknownSync(Failure)(value).message);
  return Schema.decodeUnknownSync(schema)(value);
};
export const Acknowledged = Schema.Struct({ ok: Schema.Boolean });

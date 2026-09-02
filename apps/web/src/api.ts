import { Schema } from "effect";

export const ApiOk = Schema.Struct({ ok: Schema.Literal(true) });

const ApiError = Schema.Struct({
  error: Schema.String,
  message: Schema.String,
});
const isApiError = Schema.is(ApiError);

const errorMessage = async (response: Response): Promise<string> => {
  const body = await response.text();
  try {
    const parsed: unknown = JSON.parse(body);
    if (isApiError(parsed)) return parsed.message;
  } catch {
    // Not the ApiError envelope; use the raw response body.
  }
  return body || `Request failed with status ${response.status}`;
};

export const api = async <S extends Schema.Codec<unknown, unknown, never, unknown>>(
  path: string,
  schema: S,
  init?: RequestInit,
): Promise<S["Type"]> => {
  const response = await fetch(path, init);
  if (!response.ok) throw new Error(await errorMessage(response));
  return Schema.decodeUnknownPromise(schema)(await response.json());
};

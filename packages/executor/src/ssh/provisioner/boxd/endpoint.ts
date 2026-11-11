// The rules below follow `dist/utils.js` and `dist/auth.js` of `@boxd-sh/sdk` 0.3.0.

/** The account endpoint of the hosted service, which also serves Frankfurt (`fra`). */
export const BOXD_API = "https://boxd.sh:9443";

const EXCHANGE_PATH = "/api/v1/auth/token";

/** Returns `endpoint` as a URL, adding `https://` when boxd lists only the host and port. */
export const endpointUrl = (endpoint: string): string =>
  /^[a-z][a-z0-9+.-]*:\/\//iu.test(endpoint) ? endpoint : `https://${endpoint}`;

/** Returns the host of a URL authority, with the brackets of an IPv6 literal, without the port. */
const bareHost = (authority: string): string => {
  if (!authority.startsWith("[")) return authority.split(":")[0] ?? authority;
  const end = authority.indexOf("]");
  return end === -1 ? authority : authority.slice(0, end + 1);
};

const isIpLiteral = (host: string): boolean =>
  (host.startsWith("[") && host.endsWith("]")) ||
  (/^\d{1,3}(?:\.\d{1,3}){3}$/u.test(host) &&
    host.split(".").every((octet) => Number(octet) <= 255));

/** Whether boxd dials `host` without TLS when the endpoint has no scheme. */
const isLocal = (host: string): boolean => host.startsWith("localhost") || host.startsWith("127.");

/**
 * Returns the URL that exchanges an API key for a session at the cluster of the account endpoint
 * `endpoint`. A cluster serves its API at `<zone>:9443` and its console at `https://app.<zone>`, so
 * the exchange is `https://app.<host>/api/v1/auth/token`, without the port and path of `endpoint`.
 * A `localhost`, IP literal, or `app.` host serves both, so its scheme and port stay.
 */
export const exchangeUrl = (endpoint: string): string => {
  const trimmed = endpoint.trim().replace(/\/+$/u, "");
  const scheme = ["https://", "http://"].find((prefix) => trimmed.startsWith(prefix)) ?? "";
  const rest = trimmed.slice(scheme.length);
  const authority = rest.split("/")[0] ?? rest;
  const host = bareHost(authority);
  if (host === "localhost" || isIpLiteral(host) || authority.startsWith("app."))
    return `${scheme || (isLocal(host) ? "http://" : "https://")}${authority}${EXCHANGE_PATH}`;
  return `https://app.${host}${EXCHANGE_PATH}`;
};

/**
 * Whether the API key may go as the bearer to `endpoint`: over TLS, or to a loopback address,
 * where plain text never leaves the host.
 */
export const rawKeyAllowed = (endpoint: string): boolean => {
  if (endpoint.startsWith("https://")) return true;
  const authority = endpoint.startsWith("http://") ? endpoint.slice("http://".length) : endpoint;
  if (!endpoint.startsWith("http://") && !isLocal(authority)) return true;
  const host = bareHost(authority.trim()).toLowerCase();
  return host === "localhost" || host === "[::1]" || /^127(?:\.\d{1,3}){3}$/u.test(host);
};

/**
 * Whether boxd refused the API key as a bearer, with the `UNAUTHENTICATED` message `message`,
 * because it takes only sessions: a release from before raw keys reads the key as an invalid
 * session, and one that takes keys refuses one sent without TLS.
 */
export const refusesRawKey = (message: string): boolean =>
  message.startsWith("invalid token") || message.includes("accepted over TLS only");

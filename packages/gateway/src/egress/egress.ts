import { Option, Result, Schema } from "effect";

/** A lowercase DNS host name without a trailing dot. */
export const HostName = Schema.String.check(
  Schema.isPattern(
    /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u,
    {
      message: "Expected a lowercase DNS host name",
    },
  ),
).pipe(Schema.brand("HostName"));
export type HostName = typeof HostName.Type;

/** A TCP destination port from 1 through 65535; zero is not an allowlist destination. */
export const Port = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_535 })).pipe(
  Schema.brand("Port"),
);
export type Port = typeof Port.Type;

/** The ports for an allowlist line without a port: HTTPS, and HTTP for apt mirrors. */
const DEFAULT_PORTS = [Port.make(443), Port.make(80)] as const;

/**
 * An allowlist line. `exact` permits only that host; `subdomains` permits every name below the
 * domain (`*.pythonhosted.org`) but not the domain itself.
 */
export class EgressRule extends Schema.Class<EgressRule>("@usine/gateway/EgressRule")({
  /** The lowercase host or base domain, without the wildcard prefix or trailing dot. */
  host: HostName,
  /** Whether to match only `host` or its subdomains, excluding the base domain itself. */
  match: Schema.Literals(["exact", "subdomains"]),
  /** The destination ports this rule permits; parsing a rule without a port selects 443 and 80. */
  ports: Schema.NonEmptyArray(Port),
}) {
  /** Matches `host` against this rule without checking a port. */
  covers(host: HostName): boolean {
    return this.match === "exact" ? host === this.host : host.endsWith(`.${this.host}`);
  }
}

/** The error for an invalid allowlist rule, with its line number and validation failure. */
export class EgressAllowlistError extends Schema.TaggedError<EgressAllowlistError>()(
  "EgressAllowlistError",
  {
    /** The one-based line number of the first invalid rule, including blank and comment lines. */
    line: Schema.Int,
    /** The invalid rule or port and the expected format. */
    message: Schema.String,
  },
) {}

/** A permitted destination and the rule that permits it. */
export class EgressPermitted extends Schema.TaggedClass<EgressPermitted>()("EgressPermitted", {
  /** The normalized lowercase destination host, without a trailing dot. */
  host: HostName,
  /** The destination port permitted by the matching rule. */
  port: Port,
  /** The first allowlist rule that permits both the host and the port. */
  rule: EgressRule,
}) {}

/**
 * The reason a destination is refused: unlisted host or port, an IP address, or a name that
 * resolves to a private, loopback, or link-local address. For a tunnel, also: the first bytes
 * aren't a TLS ClientHello, or the ClientHello has no server name, hides it with ECH, or has a
 * different server name than the CONNECT host.
 */
export const EgressRefusalReason = Schema.Literals([
  "host-not-allowed",
  "port-not-allowed",
  "address-literal",
  "private-address",
  "not-tls",
  "server-name-missing",
  "server-name-mismatch",
]);
export type EgressRefusalReason = typeof EgressRefusalReason.Type;

/** A refused destination. `host` is the raw host the client requested. */
export class EgressRefused extends Schema.TaggedClass<EgressRefused>()("EgressRefused", {
  /** The requested host before normalization, for diagnostics. */
  host: Schema.String,
  /** The requested port, which may be outside the valid TCP range. */
  port: Schema.Int,
  /** The allowlist, address, or TLS check that refused the destination. */
  reason: EgressRefusalReason,
}) {}

/** A forward-proxy destination allowed by a rule or refused with a reason. */
export type EgressDecision = EgressPermitted | EgressRefused;

const IPV4_LITERAL = /^\d{1,3}(?:\.\d{1,3}){3}$/u;

const isHostName = Schema.is(HostName);
const isPort = Schema.is(Port);

/**
 * The hosts workers can connect to through the forward proxy. Unlisted hosts and all IP addresses
 * are refused.
 */
export class EgressAllowlist extends Schema.Class<EgressAllowlist>(
  "@usine/gateway/EgressAllowlist",
)({
  /** Rules in evaluation order; an empty list refuses every destination. */
  rules: Schema.Array(EgressRule),
}) {
  /**
   * Checks the requested `host` and `port`, lowercasing the host and removing one trailing dot.
   * Refuses IP literals and invalid inputs. Does not resolve DNS or inspect TLS; the forward
   * proxy checks resolved addresses and the ClientHello before connecting (ADR 0027).
   */
  decide(host: string, port: number): EgressDecision {
    const normalized = host.toLowerCase().replace(/\.$/u, "");
    if (IPV4_LITERAL.test(normalized) || normalized.includes(":"))
      return new EgressRefused({ host, port, reason: "address-literal" });
    if (!isHostName(normalized) || !isPort(port))
      return new EgressRefused({ host, port, reason: "host-not-allowed" });
    const covering = this.rules.filter((rule) => rule.covers(normalized));
    if (covering.length === 0) return new EgressRefused({ host, port, reason: "host-not-allowed" });
    const rule = covering.find((candidate) => candidate.ports.includes(port));
    return rule === undefined
      ? new EgressRefused({ host, port, reason: "port-not-allowed" })
      : new EgressPermitted({ host: normalized, port, rule });
  }
}

const parseLine = (text: string, line: number): Result.Result<EgressRule, EgressAllowlistError> => {
  const match = /^(\*\.)?([^:\s]+)(?::(\d+))?$/u.exec(text);
  const host = match?.[2]?.toLowerCase();
  if (match === null || host === undefined || !isHostName(host) || IPV4_LITERAL.test(host))
    return Result.fail(
      new EgressAllowlistError({
        line,
        message: `Expected a host name, or *. and a domain, optionally followed by :port, got "${text}"`,
      }),
    );
  const port = Option.fromNullishOr(match[3]).pipe(Option.map(Number));
  if (Option.isSome(port) && !isPort(port.value))
    return Result.fail(
      new EgressAllowlistError({ line, message: `Port ${port.value} is not between 1 and 65535` }),
    );
  return Result.succeed(
    new EgressRule({
      host,
      match: match[1] === undefined ? "exact" : "subdomains",
      ports: Option.match(port, {
        onNone: () => DEFAULT_PORTS,
        onSome: (value) => [Port.make(value)] as const,
      }),
    }),
  );
};

/**
 * Parses an allowlist file with one rule per line: `host` or `*.domain`, optionally with
 * `:port` (443 and 80 by default). `#` starts a comment and blank lines are skipped.
 * Returns the first invalid rule as `EgressAllowlistError`; empty input permits no destinations.
 */
export const parseEgressAllowlist = (
  text: string,
): Result.Result<EgressAllowlist, EgressAllowlistError> => {
  const rules: Array<EgressRule> = [];
  const lines = text.split(/\r?\n/u);
  for (const [index, raw] of lines.entries()) {
    const content = raw.replace(/#.*$/u, "").trim();
    if (content === "") continue;
    const parsed = parseLine(content, index + 1);
    if (Result.isFailure(parsed)) return Result.fail(parsed.failure);
    rules.push(parsed.success);
  }
  return Result.succeed(new EgressAllowlist({ rules }));
};

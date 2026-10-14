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

/** A TCP port. */
export const Port = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_535 })).pipe(
  Schema.brand("Port"),
);
export type Port = typeof Port.Type;

/** The ports an allowlist line permits when it names none: HTTPS, and plain HTTP for apt mirrors. */
const DEFAULT_PORTS = [Port.make(443), Port.make(80)] as const;

/**
 * One allowlist line. `exact` permits that host only; `subdomains` permits
 * every name below the domain (`*.pythonhosted.org`), not the domain itself.
 */
export class EgressRule extends Schema.Class<EgressRule>("@usine/gateway/EgressRule")({
  host: HostName,
  match: Schema.Literals(["exact", "subdomains"]),
  ports: Schema.NonEmptyArray(Port),
}) {
  /** Whether this rule covers `host`, whatever the port. */
  covers(host: HostName): boolean {
    return this.match === "exact" ? host === this.host : host.endsWith(`.${this.host}`);
  }
}

/** Why the allowlist file could not be read: the line and what is wrong with it. */
export class EgressAllowlistError extends Schema.TaggedError<EgressAllowlistError>()(
  "EgressAllowlistError",
  { line: Schema.Int, message: Schema.String },
) {}

/** A destination the allowlist permits, with the rule that permits it. */
export class EgressPermitted extends Schema.TaggedClass<EgressPermitted>()("EgressPermitted", {
  host: HostName,
  port: Port,
  rule: EgressRule,
}) {}

/**
 * Why a destination is refused: its host is not listed, its port is not, it
 * is an IP address, or its name resolves to a private, loopback, or
 * link-local address (checked by a proxy that resolves names itself). For a
 * tunnel, also when the client's first bytes are not a TLS ClientHello, when
 * the ClientHello names no server or hides it with ECH, or when it names
 * another server than the CONNECT host.
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

/** A destination the allowlist refuses. `host` is the raw host the client asked for. */
export class EgressRefused extends Schema.TaggedClass<EgressRefused>()("EgressRefused", {
  host: Schema.String,
  port: Schema.Int,
  reason: EgressRefusalReason,
}) {}

export type EgressDecision = EgressPermitted | EgressRefused;

const IPV4_LITERAL = /^\d{1,3}(?:\.\d{1,3}){3}$/u;

const isHostName = Schema.is(HostName);
const isPort = Schema.is(Port);

/**
 * The hosts Workers may reach through the gateway's forward proxy. Everything
 * not listed is refused; IP addresses are always refused, since a rule names
 * hosts and an address would bypass it.
 */
export class EgressAllowlist extends Schema.Class<EgressAllowlist>(
  "@usine/gateway/EgressAllowlist",
)({ rules: Schema.Array(EgressRule) }) {
  /** Decides whether a client may open a connection to `host` on `port`. */
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
 * Parses an allowlist file: one rule per line, `#` starts a comment, blank
 * lines are skipped. A line is `host`, `*.domain`, or either with `:port`;
 * without a port the rule permits 443 and 80.
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

import { RepositoryName } from "@usine/core/repository";
import { GatewayDomain, WorkerName } from "@usine/core/worker";
import { AttachmentId } from "../src/attachment/attachment.ts";
import { Layer, Option, Redacted, Result, Schema } from "effect";
import { parseEgressAllowlist } from "../src/egress/egress.ts";
import { GITHUB_ORIGINS, type GitHubOrigins } from "../src/github/github.ts";
import type { LlmProviders } from "../src/llm/llm.ts";
import { AdminToken, CallerKey, GatewaySettings, SettingsInForce } from "../src/settings.ts";

const DOMAIN = GatewayDomain.make("gw.test");
export const WORKER = WorkerName.make("worker-one");
export const OTHER_WORKER = WorkerName.make("worker-two");
export const REPOSITORY = RepositoryName.make("acme/demo");
export const OTHER_REPOSITORY = RepositoryName.make("acme/other");
export const ATTACHMENT = AttachmentId.make("attachment-one-0000000");
export const OTHER_ATTACHMENT = AttachmentId.make("attachment-two-0000000");
export const ADMIN_TOKEN_VALUE = "admin-token-for-tests-0123456789abcdef";
const CALLER_KEY_VALUE = "caller-key-for-tests-0123456789abcdef";

/** The allowlist tests run with; `localhost` is listed so the private-address check can be seen refusing it. */
const TEST_ALLOWLIST = ["registry.npmjs.org", "*.githubusercontent.com", "localhost"].join("\n");

/** Settings for tests, with the providers a test needs, and the same settings in force. */
export const settingsLayer = (
  providers: LlmProviders,
  callerKey: string = CALLER_KEY_VALUE,
  github: GitHubOrigins = GITHUB_ORIGINS,
) =>
  SettingsInForce.layer.pipe(
    Layer.provideMerge(
      Layer.succeed(GatewaySettings)({
        domain: DOMAIN,
        github,
        providers,
        egress: Result.getOrThrow(parseEgressAllowlist(TEST_ALLOWLIST)),
        adminToken: Schema.decodeSync(AdminToken)(ADMIN_TOKEN_VALUE),
        callerKey: Schema.decodeSync(CallerKey)(callerKey),
      }),
    ),
  );

export const NO_PROVIDERS: LlmProviders = { anthropic: Option.none(), openai: Option.none() };

export const secret = (value: string) => Redacted.make(value);

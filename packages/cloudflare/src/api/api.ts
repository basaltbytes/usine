import { AttemptId } from "@usine/core/attempt";
import { safeSegment } from "@usine/core/repository";
import {
  CloudflareImageName,
  CloudflareInstanceType,
  CloudflareLlmProvider,
  WorkerName,
} from "@usine/core/worker";
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import { ProcessId, SandboxName } from "./names.ts";

export {
  ACCESS_CLIENT_ID_HEADER,
  ACCESS_CLIENT_SECRET_HEADER,
  attachPath,
  execPath,
  ProcessId,
  SandboxName,
} from "./names.ts";

/** The version of the sandbox API and the exec stream, reported by `/v1/health`. */
export const SANDBOX_PROTOCOL = 1;

/** Returns the name of the sandbox that runs `attempt` for `worker`. */
export const sandboxName = (worker: WorkerName, attempt: AttemptId): SandboxName =>
  SandboxName.make(`${worker}.${safeSegment(attempt)}`);

/** An API key that the provider's outbound handler sends in place of the sandbox's placeholder. */
export class ApiKeyCredential extends Schema.TaggedClass<ApiKeyCredential>()("ApiKey", {
  key: Schema.Redacted(Schema.NonEmptyString),
}) {}

/**
 * How a provider's outbound handler authenticates the sandbox's requests. Only API keys exist;
 * a brokered login (#549) would be another member.
 */
export const ProviderCredential = Schema.Union([ApiKeyCredential]);
export type ProviderCredential = typeof ProviderCredential.Type;

export class ProviderGrant extends Schema.Class<ProviderGrant>("@usine/cloudflare/ProviderGrant")({
  provider: CloudflareLlmProvider,
  credential: ProviderCredential,
}) {}

const uniqueProviders = Schema.makeFilter<ReadonlyArray<ProviderGrant>>(
  (grants) => new Set(grants.map(({ provider }) => provider)).size === grants.length,
  { message: "Expected each provider once" },
);

/**
 * The secrets that a sandbox's outbound handlers hold. The container never receives them. A host
 * without a credential is refused, so replacing the credentials with none revokes them.
 */
export class SandboxCredentials extends Schema.Class<SandboxCredentials>(
  "@usine/cloudflare/SandboxCredentials",
)({
  /** The Attempt's installation token, added to requests for `github.com` and `api.github.com`. */
  github: Schema.OptionFromOptionalKey(Schema.Redacted(Schema.NonEmptyString)),
  providers: Schema.Array(ProviderGrant).check(uniqueProviders),
}) {}

/** A request to create the sandbox for one Attempt, or to return it if it already runs that Attempt. */
export class CreateSandbox extends Schema.Class<CreateSandbox>("@usine/cloudflare/CreateSandbox")({
  owner: WorkerName,
  attempt: AttemptId,
  image: CloudflareImageName,
  instanceType: CloudflareInstanceType,
  credentials: SandboxCredentials,
}) {}

export class SandboxSummary extends Schema.Class<SandboxSummary>(
  "@usine/cloudflare/SandboxSummary",
)({
  name: SandboxName,
  owner: WorkerName,
  attempt: AttemptId,
  image: CloudflareImageName,
  instanceType: CloudflareInstanceType,
  createdAt: Schema.DateTimeUtc,
  /** Whether the container runs. A container that stopped lost its disk. */
  running: Schema.Boolean,
}) {}

export class SandboxList extends Schema.Class<SandboxList>("@usine/cloudflare/SandboxList")({
  sandboxes: Schema.Array(SandboxSummary),
}) {}

export class HealthReport extends Schema.Class<HealthReport>("@usine/cloudflare/HealthReport")({
  protocol: Schema.Literal(SANDBOX_PROTOCOL),
  /** The names in the Worker's `containers[].images`. */
  images: Schema.Array(CloudflareImageName),
}) {}

/** The response to a stop: the number of commands that were still running. */
export class Stopped extends Schema.Class<Stopped>("@usine/cloudflare/Stopped")({
  stopped: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
}) {}

/** The response to a destroy. `destroyed` is whether the sandbox existed. */
export class Destroyed extends Schema.Class<Destroyed>("@usine/cloudflare/Destroyed")({
  destroyed: Schema.Boolean,
}) {}

export class ProcessRunning extends Schema.TaggedClass<ProcessRunning>()("Running", {}) {}

export class ProcessExited extends Schema.TaggedClass<ProcessExited>()("Exited", {
  exitCode: Schema.Int,
}) {}

export const ProcessState = Schema.Union([ProcessRunning, ProcessExited]);
export type ProcessState = typeof ProcessState.Type;

/** A command's state and output size, read from its process files. */
export class ProcessStatus extends Schema.Class<ProcessStatus>("@usine/cloudflare/ProcessStatus")({
  process: ProcessId,
  /** The command's process ID in the container. */
  pid: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  state: ProcessState,
  stdoutBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  stderrBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
}) {}

export class SandboxNotFound extends Schema.TaggedError<SandboxNotFound>()(
  "SandboxNotFound",
  { name: SandboxName },
  { httpApiStatus: 404 },
) {}

/** The sandbox exists for another Worker or Attempt. */
export class SandboxConflict extends Schema.TaggedError<SandboxConflict>()(
  "SandboxConflict",
  { name: SandboxName, owner: WorkerName, attempt: AttemptId },
  { httpApiStatus: 409 },
) {}

/** The Worker's `containers[].images` has no image with this name. */
export class ImageNotFound extends Schema.TaggedError<ImageNotFound>()(
  "ImageNotFound",
  { image: CloudflareImageName, images: Schema.Array(Schema.String) },
  { httpApiStatus: 422 },
) {}

export class ProcessNotFound extends Schema.TaggedError<ProcessNotFound>()(
  "ProcessNotFound",
  { name: SandboxName, process: ProcessId },
  { httpApiStatus: 404 },
) {}

/** The container didn't start, stopped, or failed a command. `message` comes from the runtime. */
export class ContainerUnavailable extends Schema.TaggedError<ContainerUnavailable>()(
  "ContainerUnavailable",
  { name: SandboxName, message: Schema.String },
  { httpApiStatus: 503 },
) {}

const strict = { parseOptions: { onExcessProperty: "error" } } as const;
const sandbox = { name: SandboxName };

/** `GET /v1/health`, served by any sandbox Durable Object. */
export const healthGroup = HttpApiGroup.make("health").add(
  HttpApiEndpoint.get("health", "/v1/health", { success: HealthReport }),
);

/** `GET /v1/sandboxes`, served by the registry Durable Object. */
export const registryGroup = HttpApiGroup.make("registry").add(
  HttpApiEndpoint.get("list", "/v1/sandboxes", {
    query: { owner: WorkerName },
    success: SandboxList,
  }),
);

/** The routes of one sandbox, served by its Durable Object. */
export const sandboxGroup = HttpApiGroup.make("sandbox").add(
  HttpApiEndpoint.put("create", "/v1/sandboxes/:name", {
    params: sandbox,
    payload: CreateSandbox.annotate(strict),
    success: SandboxSummary,
    error: [SandboxConflict, ImageNotFound, ContainerUnavailable],
  }),
  HttpApiEndpoint.get("get", "/v1/sandboxes/:name", {
    params: sandbox,
    success: SandboxSummary,
    error: SandboxNotFound,
  }),
  HttpApiEndpoint.put("credentials", "/v1/sandboxes/:name/credentials", {
    params: sandbox,
    payload: SandboxCredentials.annotate(strict),
    success: SandboxSummary,
    error: [SandboxNotFound, ContainerUnavailable],
  }),
  HttpApiEndpoint.post("stop", "/v1/sandboxes/:name/stop", {
    params: sandbox,
    success: Stopped,
    error: [SandboxNotFound, ContainerUnavailable],
  }),
  HttpApiEndpoint.delete("destroy", "/v1/sandboxes/:name", {
    params: sandbox,
    success: Destroyed,
    error: ContainerUnavailable,
  }),
  HttpApiEndpoint.get("process", "/v1/sandboxes/:name/processes/:process", {
    params: { ...sandbox, process: ProcessId },
    success: ProcessStatus,
    error: [SandboxNotFound, ProcessNotFound, ContainerUnavailable],
  }),
);

/**
 * The JSON API of the Worker that usine ships (`@usine/cloudflare/worker`). Every request carries
 * the Access service token headers. Commands run through the exec stream at `execPath`, not
 * through this API.
 */
export const SandboxApi = HttpApi.make("SandboxApi").add(healthGroup, registryGroup, sandboxGroup);

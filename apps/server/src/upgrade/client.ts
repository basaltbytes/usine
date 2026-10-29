import type { InstanceDirectory } from "@usine/core/instance";
import { ReleaseVersion } from "@usine/core/upgrade";
import { OperatorApi, UpgradeRequest } from "@usine/orchestrator/operator/http";
import { Console, Effect, Option, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { readAdminToken } from "../auth/local.ts";
import { HttpApiClient } from "effect/http-api";
import type { UpgradeCommand } from "../cli.ts";
import { compareVersions, SERVER_PACKAGE } from "../instance/manifest.ts";
import type { InstanceRecord } from "../instance/record.ts";
import { resolveVersion } from "../registry.ts";
import { UpgradeError } from "./control.ts";

export const requestSystemUpgrade = Effect.fn("Cli.requestSystemUpgrade")(
  function* (directory: InstanceDirectory, record: InstanceRecord, command: UpgradeCommand) {
    const token = yield* readAdminToken(directory);
    const client = yield* HttpApiClient.make(OperatorApi, {
      transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken(token)),
      baseUrl: `http://127.0.0.1:${record.launch.port}`,
    });
    const status = yield* client.operator.upgradeStatus({});
    const spec = Option.getOrElse(command.version, () => status.channel);
    const target = yield* resolveVersion(directory, SERVER_PACKAGE, spec).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(ReleaseVersion)),
    );
    yield* Console.log(`Running ${record.version}; ${spec}: ${target}.`);
    if (command.check) return;
    if (Option.isNone(command.version) && compareVersions(target, record.version) <= 0) {
      yield* Console.log("The server is up to date.");
      return;
    }
    yield* client.operator.requestUpgrade({
      payload: new UpgradeRequest({
        timing: command.options.force ? "now" : "idle",
        version: Option.some(target),
      }),
    });
    yield* Console.log(
      `Upgrade to ${target} requested. Follow progress in Settings or the upgrade service journal.`,
    );
  },
  Effect.mapError((error) => new UpgradeError({ message: error.message })),
);

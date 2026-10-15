#!/usr/bin/env node
import { isIP } from "node:net";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Config, Console, Effect, Schema } from "effect";
import { dnsmasqConfiguration } from "../egress/dnsmasq.ts";
import { GatewayDomain } from "../settings.ts";
import { allowlistFromEnvironment } from "./environment.ts";

/** The private address Workers reach the transparent listener at. */
const TransparentAddress = Schema.String.check(
  Schema.makeFilter((value: string) => isIP(value) !== 0, { message: "Expected an IP address" }),
);

// Prints dnsmasq's answers for the egress allowlist; the gateway VM writes them to /etc/dnsmasq.d before each start of the gateway.
NodeRuntime.runMain(
  Effect.gen(function* () {
    const domain = yield* Config.schema(GatewayDomain, "USINE_GATEWAY_DOMAIN");
    const address = yield* Config.schema(TransparentAddress, "USINE_GATEWAY_TRANSPARENT_HOST");
    const { path, egress } = yield* allowlistFromEnvironment;
    yield* Console.log(
      [
        `# Answers from ${path}, written by usine-gateway-dnsmasq; edit that file instead.`,
        ...dnsmasqConfiguration(egress, { domain, address }),
      ].join("\n"),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

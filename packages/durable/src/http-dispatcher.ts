// Adapted from @earendil-works/pi-coding-agent 1.4.0, src/core/http-dispatcher.ts.
// https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/src/core/http-dispatcher.ts
// MIT License, Copyright (c) Mario Zechner and contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

import { EventEmitter } from "node:events";
import { Effect } from "effect";
import {
  Client,
  type Dispatcher,
  EnvHttpProxyAgent,
  install,
  Pool,
  setGlobalDispatcher,
} from "undici";
import { durableError } from "./harness.ts";

const originalFetch = globalThis.fetch;
let installed = false;

// The response body still rejects; this prevents an unhandled EventEmitter error
// from terminating the orchestrator when undici tears down a broken stream.
const ignoreDispatcherError = () => {};

const withErrorListener = <T extends Dispatcher>(dispatcher: T): T => {
  EventEmitter.prototype.on.call(dispatcher, "error", ignoreDispatcherError);
  return dispatcher;
};

const createClient = (origin: string | URL, options: Client.Options) =>
  withErrorListener(new Client(origin, options));

const createOriginDispatcher = (origin: string | URL, options: Pool.Options) =>
  options.connections === 1
    ? createClient(origin, options)
    : withErrorListener(new Pool(origin, { ...options, factory: createClient }));

export const configureHarnessHttp = Effect.fn("DurableHarness.configureHttp")(function* (
  httpProxy: string | undefined,
) {
  if (installed) {
    yield* Effect.logDebug("Durable harness HTTP dispatcher already installed");
    return;
  }
  const replacedFetch = yield* Effect.try({
    try: () => {
      const proxy = httpProxy?.trim();
      if (proxy) {
        process.env.HTTP_PROXY ??= proxy;
        process.env.HTTPS_PROXY ??= proxy;
      }
      const dispatcher = withErrorListener(
        new EnvHttpProxyAgent({
          allowH2: false,
          proxyTunnel: true,
          bodyTimeout: 300_000,
          headersTimeout: 300_000,
          connect: { autoSelectFamilyAttemptTimeout: 2_000 },
          clientFactory: createClient,
          factory: createOriginDispatcher,
        }),
      );
      setGlobalDispatcher(dispatcher);
      const replaceFetch = globalThis.fetch === originalFetch;
      if (replaceFetch) install();
      installed = true;
      return replaceFetch;
    },
    catch: (cause) => durableError("configure the harness HTTP dispatcher", cause),
  });
  yield* Effect.logInfo("Durable harness HTTP dispatcher installed", {
    bodyTimeoutMs: 300_000,
    headersTimeoutMs: 300_000,
    replacedFetch,
  });
});

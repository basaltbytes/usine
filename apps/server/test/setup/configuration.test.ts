import { NodeServices } from "@effect/platform-node";
import { InstanceDirectory } from "@usine/core/instance";
import { ConfigurationStore } from "@usine/config/configuration";
import { ConfigurationFolder } from "@usine/config/folder-codec";
import { memoryConfigurationLayer } from "@usine/config/memory";
import { ConfigParser } from "@usine/config/parser";
import { MarcbachmannCelLayer } from "@usine/expression/marcbachmann-cel";
import { Effect, FileSystem, Layer, Option } from "effect";
import { assert, it } from "vitest";
import { initializeConfiguration } from "../../src/configuration/runtime.ts";

const parser = ConfigParser.layer.pipe(Layer.provide(MarcbachmannCelLayer));
const services = Layer.mergeAll(memoryConfigurationLayer, ConfigurationFolder.layer).pipe(
  Layer.provideMerge(parser),
  Layer.provideMerge(NodeServices.layer),
);
it("starts an empty instance with one database revision and resumes without creating bootstrap files", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = InstanceDirectory.make(
        yield* fs.makeTempDirectoryScoped({ prefix: "usine-empty-setup-" }),
      );
      const first = yield* initializeConfiguration(root);
      assert.equal(first.number, 1);
      assert.deepEqual(first.instance.config.repos, []);
      assert.equal(Option.isNone(first.instance.config.operator), true);
      assert.deepEqual(yield* fs.readDirectory(root), []);
      const second = yield* initializeConfiguration(root);
      assert.equal(second.number, first.number);
      assert.equal((yield* (yield* ConfigurationStore).list(Option.none())).length, 1);
    }).pipe(Effect.scoped, Effect.provide(services)),
  ));

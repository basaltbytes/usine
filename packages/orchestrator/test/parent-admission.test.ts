import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { ConfigurationFolder } from "@usine/config/folder-codec";
import { ConfigParser } from "@usine/config/parser";
import { InstanceDirectory } from "@usine/core/instance";
import { fauxParent } from "@usine/durable/testing";
import { MarcbachmannCelLayer } from "@usine/expression/marcbachmann-cel";
import { Effect, FileSystem, Layer } from "effect";
import { vi } from "vitest";
import { parentAdmissionProblems } from "../src/parent-admission.ts";
import { writeInstanceFiles } from "./support/instance-folder.ts";

const testLayer = ConfigurationFolder.layer.pipe(
  Layer.provideMerge(ConfigParser.layer.pipe(Layer.provide(MarcbachmannCelLayer))),
  Layer.provideMerge(NodeServices.layer),
);

const agentFile = (effort: string) =>
  `---\nharness: codex\nmodel: gpt-6.1-sol\neffort: ${effort}\n---\nReview the pull request.\n`;

it.effect("checks each distinct coordinator brain once", () =>
  Effect.gen(function* () {
    const directory = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped();
    const root = InstanceDirectory.make(directory);
    yield* writeInstanceFiles(root, [
      ["usine.yaml", "version: 2\noperator: operator\nrepos: [{ name: acme/project }]\n"],
      ["agents/first.md", agentFile("high")],
      ["agents/second.md", agentFile("high")],
      ["agents/third.md", agentFile("medium")],
    ]);
    const loaded = yield* (yield* ConfigurationFolder).load(root);
    const parents = fauxParent([]);
    const lookups = vi.spyOn(parents.models, "getModel");

    const problems = yield* parentAdmissionProblems(loaded, parents);

    expect(problems).toEqual([]);
    expect(lookups).toHaveBeenCalledTimes(2);
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

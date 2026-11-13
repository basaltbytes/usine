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

const withId = <A extends { readonly id: string }>(model: A | undefined, id: string) =>
  model === undefined ? undefined : { ...model, id };

const agentFile = (effort: string, frontmatter = "") =>
  `---\nharness: codex\nmodel: gpt-6.1-sol\neffort: ${effort}\n${frontmatter}---\nReview the pull request.\n`;

it.effect("asks the credential's login once per provider across models and efforts", () =>
  Effect.gen(function* () {
    const directory = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped();
    const root = InstanceDirectory.make(directory);
    yield* writeInstanceFiles(root, [
      ["usine.yaml", "version: 2\noperator: operator\nrepos: [{ name: acme/project }]\n"],
      ["agents/first.md", agentFile("high")],
      ["agents/second.md", agentFile("high", "parent_effort: medium\n")],
      ["agents/third.md", agentFile("high", "parent_model: faux/faux-2\nparent_effort: low\n")],
    ]);
    const loaded = yield* (yield* ConfigurationFolder).load(root);
    const parents = fauxParent([]);
    const served = parents.models.getModel.bind(parents.models);
    const lookups = vi
      .spyOn(parents.models, "getModel")
      .mockImplementation((provider, id) =>
        id === "faux-2" ? withId(served(provider, "faux-1"), id) : served(provider, id),
      );
    const logins = vi.spyOn(parents.models, "checkAuth");

    const problems = yield* parentAdmissionProblems(loaded, parents);

    expect(problems).toEqual([]);
    expect(lookups).toHaveBeenCalledTimes(3);
    expect(logins).toHaveBeenCalledTimes(1);
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("names each agent that a refused login affects", () =>
  Effect.gen(function* () {
    const directory = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped();
    const root = InstanceDirectory.make(directory);
    yield* writeInstanceFiles(root, [
      ["usine.yaml", "version: 2\noperator: operator\nrepos: [{ name: acme/project }]\n"],
      ["agents/alpha.md", agentFile("high")],
      ["agents/beta.md", agentFile("high", "parent_effort: low\n")],
    ]);
    const loaded = yield* (yield* ConfigurationFolder).load(root);
    const parents = fauxParent([]);
    const logins = vi.spyOn(parents.models, "checkAuth").mockResolvedValue(undefined);

    const problems = yield* parentAdmissionProblems(loaded, parents);

    expect(problems.map(({ file }) => file)).toEqual(["agents/alpha.md", "agents/beta.md"]);
    expect(problems.map(({ message }) => message)).toEqual([
      expect.stringMatching(/^Agent "alpha" cannot run as coordinator: .*requires a credential/u),
      expect.stringMatching(/^Agent "beta" cannot run as coordinator: .*requires a credential/u),
    ]);
    expect(logins).toHaveBeenCalledTimes(1);
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("resolves each agent's parent effort against the instance default", () =>
  Effect.gen(function* () {
    const directory = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped();
    const root = InstanceDirectory.make(directory);
    yield* writeInstanceFiles(root, [
      [
        "usine.yaml",
        "version: 2\noperator: operator\nrepos: [{ name: acme/project }]\nsettings:\n  parent_effort: max\n",
      ],
      ["agents/alpha.md", agentFile("high", "parent_effort: high\n")],
      ["agents/beta.md", agentFile("high")],
    ]);
    const loaded = yield* (yield* ConfigurationFolder).load(root);
    const parents = fauxParent([]);
    const lookups = vi.spyOn(parents.models, "getModel");

    const problems = yield* parentAdmissionProblems(loaded, parents);

    expect(problems.map(({ file }) => file)).toEqual(["agents/beta.md"]);
    expect(problems[0]?.message).toContain("doesn't support effort");
    expect(lookups).toHaveBeenCalledTimes(2);
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("checks no parent brain for agents on the event-driven coordinator", () =>
  Effect.gen(function* () {
    const directory = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped();
    const root = InstanceDirectory.make(directory);
    yield* writeInstanceFiles(root, [
      [
        "usine.yaml",
        "version: 2\noperator: operator\nrepos: [{ name: acme/project }]\nsettings:\n  coordinator: events\n",
      ],
      ["agents/alpha.md", agentFile("high")],
      ["agents/beta.md", agentFile("high", "coordinator: session\nparent_effort: max\n")],
    ]);
    const loaded = yield* (yield* ConfigurationFolder).load(root);
    const parents = fauxParent([]);
    const lookups = vi.spyOn(parents.models, "getModel");

    const problems = yield* parentAdmissionProblems(loaded, parents);

    expect(problems.map(({ file }) => file)).toEqual(["agents/beta.md"]);
    expect(lookups).toHaveBeenCalledTimes(1);

    yield* writeInstanceFiles(root, [["agents/beta.md", agentFile("high")]]);
    lookups.mockClear();
    const reloaded = yield* (yield* ConfigurationFolder).load(root);
    const unparented = yield* parentAdmissionProblems(reloaded, parents);
    expect(unparented).toEqual([]);
    expect(lookups).not.toHaveBeenCalled();
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

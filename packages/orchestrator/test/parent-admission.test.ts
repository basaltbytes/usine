import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { ConfigurationFolder } from "@usine/config/folder-codec";
import { ConfigParser } from "@usine/config/parser";
import { InstanceDirectory } from "@usine/core/instance";
import { fauxParent } from "@usine/durable/testing";
import { MarcbachmannCelLayer } from "@usine/expression/marcbachmann-cel";
import { Effect, FileSystem, Layer, Option } from "effect";
import { vi } from "vitest";
import { parentAdmissionProblems } from "../src/parent-admission.ts";
import { writeInstanceFiles } from "./support/instance-folder.ts";

const testLayer = ConfigurationFolder.layer.pipe(
  Layer.provideMerge(ConfigParser.layer.pipe(Layer.provide(MarcbachmannCelLayer))),
  Layer.provideMerge(NodeServices.layer),
);

const withId = <A extends { readonly id: string }>(model: A | undefined, id: string) =>
  model === undefined ? undefined : { ...model, id };

const withProvider = <A extends { readonly provider: string }>(
  model: A | undefined,
  provider: string,
) => (model === undefined ? undefined : { ...model, provider });

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

/** Serves `faux-1` under a second provider, `other`, whose credential has no login. */
const withOtherProvider = (parents: ReturnType<typeof fauxParent>) => {
  const served = parents.models.getModel.bind(parents.models);
  const answer = parents.models.checkAuth.bind(parents.models);
  vi.spyOn(parents.models, "getModel").mockImplementation((provider, id) =>
    provider === "other" ? withProvider(served("faux", id), provider) : served(provider, id),
  );
  return vi
    .spyOn(parents.models, "checkAuth")
    .mockImplementation((provider, options) =>
      provider === "other" ? Promise.resolve(undefined) : answer(provider, options),
    );
};

it.effect.each([
  { first: "other", second: "faux" },
  { first: "faux", second: "other" },
])("keeps each provider's login answer apart ($first first)", ({ first, second }) =>
  Effect.gen(function* () {
    const directory = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped();
    const root = InstanceDirectory.make(directory);
    yield* writeInstanceFiles(root, [
      ["usine.yaml", "version: 2\noperator: operator\nrepos: [{ name: acme/project }]\n"],
      ["agents/alpha.md", agentFile("high", `parent_model: ${first}/faux-1\n`)],
      ["agents/beta.md", agentFile("high", `parent_model: ${second}/faux-1\n`)],
      ["agents/gamma.md", agentFile("high", `parent_model: ${first}/faux-1\nparent_effort: low\n`)],
      [
        "agents/delta.md",
        agentFile("high", `parent_model: ${second}/faux-1\nparent_effort: low\n`),
      ],
    ]);
    const loaded = yield* (yield* ConfigurationFolder).load(root);
    const parents = fauxParent([]);
    const logins = withOtherProvider(parents);

    const problems = yield* parentAdmissionProblems(loaded, parents);

    const refused = first === "other" ? ["alpha", "gamma"] : ["beta", "delta"];
    expect(problems.map(({ file }) => file)).toEqual(refused.map((agent) => `agents/${agent}.md`));
    expect(problems.map(({ message }) => message)).toEqual(
      refused.map((agent) =>
        expect.stringMatching(
          new RegExp(`^Agent "${agent}" cannot run as coordinator: .*requires a credential`, "u"),
        ),
      ),
    );
    expect(logins.mock.calls.map(([provider]) => provider)).toEqual([first, second]);
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("gives a failed login check to each agent on the provider", () =>
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
    const logins = vi
      .spyOn(parents.models, "checkAuth")
      .mockRejectedValue(new Error("credential store unreachable"));

    const problems = yield* parentAdmissionProblems(loaded, parents);

    expect(problems.map(({ file }) => file)).toEqual(["agents/alpha.md", "agents/beta.md"]);
    expect(problems.map(({ message }) => message)).toEqual([
      `Agent "alpha" cannot run as coordinator: Can't check the parent model's credential`,
      `Agent "beta" cannot run as coordinator: Can't check the parent model's credential`,
    ]);
    expect(logins).toHaveBeenCalledTimes(1);
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("asks the gateway's login once per provider when it selects the parent model", () =>
  Effect.gen(function* () {
    const directory = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped();
    const root = InstanceDirectory.make(directory);
    yield* writeInstanceFiles(root, [
      ["usine.yaml", "version: 2\noperator: operator\nrepos: [{ name: acme/project }]\n"],
      ["agents/alpha.md", agentFile("high")],
      ["agents/beta.md", agentFile("high", "parent_effort: medium\n")],
      ["agents/gamma.md", agentFile("high", "parent_effort: low\n")],
    ]);
    const loaded = yield* (yield* ConfigurationFolder).load(root);
    const parents = fauxParent([]);
    const faux = parents.models.getModel("faux", "faux-1");
    if (faux === undefined) return yield* Effect.die("The faux provider serves no faux-1");
    vi.spyOn(parents.models, "getAvailable").mockResolvedValue([
      { ...faux, provider: "other" },
      faux,
    ]);
    const authentication = vi.fn((provider: string) =>
      Effect.succeed(provider === "faux" ? ({ _tag: "ApiKey" } as const) : undefined),
    );

    const problems = yield* parentAdmissionProblems(loaded, {
      models: parents.models,
      defaultModel: Option.none(),
      credentials: { route: "gateway", authentication },
    });

    expect(problems).toEqual([]);
    expect(authentication.mock.calls.map(([provider]) => provider)).toEqual(["other", "faux"]);
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect.each([
  { case: "one effort", efforts: ["high", "high", "high"] },
  { case: "several efforts", efforts: ["high", "medium", "low"] },
])("lists the host login's models once when it selects the parent model ($case)", ({ efforts }) =>
  Effect.gen(function* () {
    const directory = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped();
    const root = InstanceDirectory.make(directory);
    yield* writeInstanceFiles(root, [
      ["usine.yaml", "version: 2\noperator: operator\nrepos: [{ name: acme/project }]\n"],
      ...efforts.map(
        (effort, index) =>
          [`agents/agent-${index}.md`, agentFile("high", `parent_effort: ${effort}\n`)] as const,
      ),
    ]);
    const loaded = yield* (yield* ConfigurationFolder).load(root);
    const parents = fauxParent([]);
    const logins = withOtherProvider(parents);
    const faux = parents.models.getModel("faux", "faux-1");
    if (faux === undefined) return yield* Effect.die("The faux provider serves no faux-1");
    // Like Pi's ModelRuntime, listing the available models checks every provider's login.
    const providers = ["other", "faux"];
    const listings = vi
      .spyOn(parents.models, "getAvailable")
      .mockImplementation((_provider, options) =>
        Promise.all(providers.map((provider) => parents.models.checkAuth(provider, options))).then(
          (answers) =>
            providers
              .filter((_, index) => answers[index] !== undefined)
              .map((provider) => ({ ...faux, provider })),
        ),
      );

    const problems = yield* parentAdmissionProblems(loaded, {
      ...parents,
      defaultModel: Option.none(),
    });

    expect(problems).toEqual([]);
    expect(listings).toHaveBeenCalledTimes(1);
    expect(logins.mock.calls.map(([provider]) => provider)).toEqual(["other", "faux", "faux"]);
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

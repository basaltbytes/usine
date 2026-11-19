import { describe, expect, it } from "vitest";
import { emitDeclarations } from "./emit.mjs";

const ref = (name) => ({ $ref: `#/definitions/v2/${name}` });
const tag = (value) => ({ enum: [value], type: "string" });
const variant = (title, type) => ({
  title,
  type: "object",
  properties: { type: tag(type), text: { type: "string" } },
  required: ["type", "text"],
});

describe("emitDeclarations", () => {
  it("rejects a variant title that names a definition emitted later", () => {
    const definitions = {
      Item: { oneOf: [variant("RateLimitWindow", "plan")] },
      Root: {
        type: "object",
        properties: { item: ref("Item"), window: ref("RateLimitWindow") },
        required: ["item", "window"],
      },
      RateLimitWindow: {
        type: "object",
        properties: { usedPercent: { type: "integer" } },
        required: ["usedPercent"],
      },
    };
    expect(() => emitDeclarations(definitions, ["Root"])).toThrow(
      "Two schemas share the export name RateLimitWindow",
    );
  });

  it("rejects variant type tags that are not inline single-value enums", () => {
    const wrapped = (type) => ({
      oneOf: [
        { ...variant("PlanItem", "plan"), properties: { type } },
        variant("OtherItem", "other"),
      ],
    });
    for (const type of [
      ref("PlanType"),
      { allOf: [ref("PlanType")] },
      { type: "string" },
      { enum: ["plan", "draft"], type: "string" },
    ]) {
      const definitions = { Item: wrapped(type), PlanType: tag("plan") };
      expect(() => emitDeclarations(definitions, ["Item"])).toThrow(
        "Variant PlanItem needs an inline single-value type tag",
      );
    }
  });

  it("validates referenced variant tags even when the definition was already emitted", () => {
    for (const type of [
      ref("PlanType"),
      { allOf: [ref("PlanType")] },
      { type: "string" },
      { enum: ["plan", "draft"], type: "string" },
    ]) {
      const definitions = {
        Item: { oneOf: [ref("PlanItem"), variant("OtherItem", "other")] },
        PlanItem: { ...variant("PlanItem", "plan"), properties: { type } },
        PlanType: tag("plan"),
      };
      for (const roots of [["Item"], ["PlanItem", "Item"]]) {
        expect(() => emitDeclarations(definitions, roots)).toThrow(
          "Variant PlanItem needs an inline single-value type tag",
        );
      }
    }
  });

  it("rejects open tags inherited by inline union variants", () => {
    for (const keyword of ["oneOf", "anyOf"]) {
      const definitions = {
        Item: {
          type: "object",
          properties: { type: { type: "string" }, id: { type: "string" } },
          required: ["type", "id"],
          [keyword]: [
            {
              title: "A",
              type: "object",
              properties: { a: { type: "string" } },
              required: ["a"],
            },
            {
              title: "B",
              type: "object",
              properties: { type: tag("b"), b: { type: "string" } },
              required: ["b"],
            },
          ],
        },
      };
      expect(() => emitDeclarations(definitions, ["Item"])).toThrow(
        "Variant A needs an inline single-value type tag",
      );
    }
  });

  it("rejects reference wrappers with sibling constraints", () => {
    for (const wrapper of [ref("PlanItem"), { allOf: [ref("PlanItem")] }]) {
      for (const sibling of [
        { properties: { type: tag("plan") } },
        { required: ["type"] },
        { type: "object" },
        { anyOf: [variant("OtherItem", "other")] },
      ]) {
        const definitions = {
          Item: { oneOf: [{ title: "WrappedItem", ...wrapper, ...sibling }] },
          PlanItem: variant("PlanItem", "plan"),
        };
        expect(() => emitDeclarations(definitions, ["Item"])).toThrow(
          "Wrapper sibling constraints need explicit support",
        );
      }
    }
  });

  it("rejects variants that an earlier variant would decode", () => {
    const untagged = {
      title: "TextItem",
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    };
    for (const [alternatives, message] of [
      [
        [variant("PlanItem", "plan"), variant("DraftItem", "plan")],
        "Variant PlanItem accepts the values of variant DraftItem; they need distinct tags",
      ],
      [
        [untagged, variant("PlanItem", "plan")],
        "Variant TextItem accepts the values of variant PlanItem; they need distinct tags",
      ],
      [
        [
          untagged,
          {
            title: "PlanItem",
            type: "object",
            properties: { type: tag("plan"), text: { type: "string" } },
            required: ["type"],
          },
        ],
        "Variant TextItem accepts the values of variant PlanItem; they need distinct tags",
      ],
      ...[
        { type: "object" },
        { type: "object", properties: {} },
        { type: "object", additionalProperties: { type: "string" } },
        { type: "object", additionalProperties: true },
        { type: ["string", "object"] },
        { type: ["object", "null"] },
        { description: "Any value" },
      ].map((bag) => [
        [untagged, { title: "BagItem", ...bag }],
        "Variant TextItem accepts the values of variant BagItem; they need distinct tags",
      ]),
      [
        [untagged, true],
        "Variant TextItem accepts the values of variant without a title; they need distinct tags",
      ],
      [
        [{ title: "BagItem", type: ["string", "object"] }, untagged],
        "Variant BagItem accepts the values of variant TextItem; they need distinct tags",
      ],
    ]) {
      const definitions = { Item: { anyOf: alternatives } };
      expect(() => emitDeclarations(definitions, ["Item"])).toThrow(message);
    }
  });

  it("rejects a variant that accepts every object unless it follows variants tagged by their only key", () => {
    const keyed = {
      title: "HttpFailed",
      type: "object",
      additionalProperties: false,
      properties: { httpFailed: { type: "object" } },
      required: ["httpFailed"],
    };
    const fallback = { title: "UnknownInfo", type: ["string", "object"] };
    const { additionalProperties: _closed, ...open } = keyed;
    for (const [alternatives, message] of [
      [
        [open, fallback],
        "Variant HttpFailed accepts the values of variant UnknownInfo; they need distinct tags",
      ],
      [
        [
          {
            ...keyed,
            properties: { ...keyed.properties, code: { type: "integer" } },
          },
          fallback,
        ],
        "Variant HttpFailed accepts the values of variant UnknownInfo; they need distinct tags",
      ],
      [
        [keyed, fallback, { title: "OtherInfo", type: "object" }],
        "Variant HttpFailed accepts the values of variant UnknownInfo; they need distinct tags",
      ],
      [
        [
          keyed,
          {
            title: "OpenInfo",
            type: "object",
            properties: { httpFailed: { type: "object" }, detail: { type: "string" } },
          },
        ],
        "Variant HttpFailed accepts the values of variant OpenInfo; they need distinct tags",
      ],
    ]) {
      const definitions = { ErrorInfo: { anyOf: alternatives } };
      expect(() => emitDeclarations(definitions, ["ErrorInfo"])).toThrow(message);
    }
  });

  it("compares the variants of a nested union with the variants beside it", () => {
    const tagged = (title, type, required) => ({
      title,
      type: "object",
      properties: { type: tag(type), x: { type: "string" } },
      required,
    });
    for (const definitions of [
      {
        Item: { anyOf: [ref("Inner"), tagged("BItem", "b", ["type", "x"])] },
        Inner: { oneOf: [tagged("AItem", "b", ["type"]), tagged("CItem", "c", ["type"])] },
      },
      {
        Item: { anyOf: [tagged("BItem", "b", ["type"]), ref("Inner")] },
        Inner: { oneOf: [tagged("AItem", "b", ["type", "x"]), tagged("CItem", "c", ["type"])] },
      },
    ]) {
      expect(() => emitDeclarations(definitions, ["Item"])).toThrow(
        /Variant [AB]Item accepts the values of variant [AB]Item/u,
      );
    }
  });
});

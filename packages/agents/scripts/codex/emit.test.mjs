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

  it("rejects a variant title that names a definition emitted earlier", () => {
    const definitions = {
      Plan: { type: "object", properties: { text: { type: "string" } } },
      Item: { oneOf: [variant("Plan", "plan")] },
    };
    expect(() => emitDeclarations(definitions, ["Plan", "Item"])).toThrow(
      "Two schemas share the export name Plan",
    );
  });

  it("rejects enums whose type also allows other values", () => {
    const definitions = { Status: { enum: ["active"], type: ["string", "null"] } };
    expect(() => emitDeclarations(definitions, ["Status"])).toThrow(
      'Enums of type ["string","null"] need explicit support',
    );
  });

  it("rejects const schemas", () => {
    const definitions = {
      Item: { type: "object", properties: { type: { const: "plan", type: "string" } } },
    };
    expect(() => emitDeclarations(definitions, ["Item"])).toThrow(
      "const schemas need explicit support",
    );
  });

  it("rejects variant type tags that are not inline single-value enums", () => {
    const wrapped = (type) => ({
      oneOf: [{ ...variant("PlanItem", "plan"), properties: { type } }],
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

  it("keeps the parent's required fields on merged variants", () => {
    const definitions = {
      Item: {
        oneOf: [
          {
            title: "ImageItem",
            type: "object",
            properties: { type: tag("image"), id: { type: "string" } },
            required: ["id", "type"],
            anyOf: [
              {
                title: "FileImageItem",
                type: "object",
                properties: { fileId: { type: "string" } },
                required: ["fileId"],
              },
            ],
          },
        ],
      },
    };
    const declarations = emitDeclarations(definitions, ["Item"]);
    expect(declarations.get("FileImageItem")).toBe(
      'Schema.Struct({"type": Schema.Literal("image"),\n"id": Schema.String,\n"fileId": Schema.String})',
    );
  });

  it("lists the string members of a union that mixes enums and objects", () => {
    const definitions = {
      ErrorInfo: {
        anyOf: [
          { enum: ["serverOverloaded", "other"], type: "string" },
          {
            title: "HttpErrorInfo",
            type: "object",
            properties: { status: { type: "integer" } },
            required: ["status"],
          },
        ],
      },
    };
    expect(emitDeclarations(definitions, ["ErrorInfo"]).get("ErrorInfoValues")).toBe(
      '["serverOverloaded","other"] as const',
    );
  });
});

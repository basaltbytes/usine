/**
 * @usine/expression — a vendor-neutral CEL check/evaluation seam. The live
 * layer exact-pins @marcbachmann/cel-js; callers depend only on CEL types and
 * typed Effect failures, so another backend can implement the service.
 */
export * from "./expression-engine.ts";
export * from "./marcbachmann-cel.ts";
export * from "./model.ts";

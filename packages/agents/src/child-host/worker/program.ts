// The standalone bootstrap serializes source text at the Node process boundary.
// @effect-diagnostics globalJson:off
export interface WorkerSources {
  readonly owner: string;
  readonly lifeline: string;
}

export interface Launch {
  readonly mode: "supervise" | "attach" | "replace" | "resume";
  readonly cursor: number;
  readonly lease: number;
  readonly environmentKeys: string;
  readonly command: string;
  readonly args: string[];
}

export const ownerProgram = (sources: WorkerSources) =>
  `${sources.owner}\nChildHostWorker.run(${JSON.stringify(sources)});`;

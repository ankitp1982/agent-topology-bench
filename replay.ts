import { readFileSync } from "node:fs";
import { type RecordedDataset, type RecordedRun } from "./trace_recorder.ts";
import { analyzeTopology, type ExecutionTopology } from "./topology.ts";

export type { RecordedDataset, RecordedRun, WorkloadScenario } from "./trace_recorder.ts";

export interface SimulationOutcome {
  strategy: ExecutionTopology | "auto_routed";
  accuracyRate: number;
  avgTokens: number;
  p95RoutingMs: number;
  scoredRuns: number;
}

export class MissingTraceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissingTraceError";
  }
}

const DEFAULT_TRACE_URL = new URL("./traces/recorded_runs.json", import.meta.url);

export function loadRecordedTraces(path: string | URL = DEFAULT_TRACE_URL): RecordedDataset {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as RecordedDataset;
  if (!Array.isArray(parsed.scenarios) || parsed.scenarios.length === 0 || !Array.isArray(parsed.runs)) {
    throw new Error("Invalid recorded trace dataset");
  }
  return parsed;
}

function extractSingle(segment: string): string | null {
  const tagged = segment.match(/ANSWER:\s*([^\n\r|]+)/i);
  if (tagged?.[1]) return tagged[1].trim().replace(/[.,;]+$/, "").replace(/\s*,\s*/g, ",");
  const nums = segment.match(/-?\d+(?:\.\d+)?/g);
  return nums && nums.length > 0 ? nums[nums.length - 1]! : null;
}

export function extractAnswer(output: string): string | null {
  if (!output.trim()) return null;
  if (output.includes("|")) {
    const parts = output.split("|").map((p) => extractSingle(p));
    return parts.every((p) => p !== null) ? parts.join(",") : null;
  }
  return extractSingle(output);
}

export function scoreRecordedRun(run: RecordedRun, expected: string): boolean {
  if (run.status !== "completed") return false;
  const actual = extractAnswer(run.output);
  return actual !== null && actual.toLowerCase() === expected.trim().replace(/\s*,\s*/g, ",").toLowerCase();
}

export function runReplaySuite(dataset: RecordedDataset, strategy: ExecutionTopology | "auto_routed"): SimulationOutcome {
  if (dataset.scenarios.length === 0) throw new Error("Trace dataset has no scenarios");
  const byKey = new Map(dataset.runs.map((r) => [`${r.scenario}::${r.strategy}`, r]));
  let wins = 0, totalTokens = 0;
  const routingLatenciesMs: number[] = [];

  for (const s of dataset.scenarios) {
    const t0 = performance.now();
    const chosen = strategy === "auto_routed" ? analyzeTopology(s.nodes).topology : strategy;
    routingLatenciesMs.push(performance.now() - t0);
    const run = byKey.get(`${s.name}::${chosen}`);
    if (!run) throw new MissingTraceError(`Missing recorded trace for ${s.name} (${chosen})`);
    if (scoreRecordedRun(run, s.expected)) wins += 1;
    totalTokens += run.totalTokens;
  }

  routingLatenciesMs.sort((a, b) => a - b);
  const p95Idx = Math.min(routingLatenciesMs.length - 1, Math.floor(routingLatenciesMs.length * 0.95));
  return {
    strategy,
    accuracyRate: Number(((wins / dataset.scenarios.length) * 100).toFixed(1)),
    avgTokens: Math.round(totalTokens / dataset.scenarios.length),
    p95RoutingMs: Number((routingLatenciesMs[p95Idx] ?? 0).toFixed(4)),
    scoredRuns: dataset.scenarios.length,
  };
}

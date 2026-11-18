import { analyzeTopology, type ExecutionTopology, type TaskNode } from "./topology.ts";

export interface WorkloadScenario {
  name: string;
  family: "parallel_independent" | "hybrid_pipeline" | "sequential_coupled";
  nodes: TaskNode[];
}

export interface SimulationOutcome {
  strategy: ExecutionTopology | "auto_routed";
  accuracyRate: number;
  avgTokens: number;
  p95RoutingMs: number;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function buildBenchmarkWorkloads(): WorkloadScenario[] {
  const scenarios: WorkloadScenario[] = [];

  for (let i = 0; i < 8; i++) {
    const count = 4 + (i % 4);
    const nodes: TaskNode[] = [];
    for (let k = 0; k < count; k++) {
      nodes.push({ id: `p_${i}_${k}`, dependsOn: [], estimatedTokens: 700 + k * 90 });
    }
    scenarios.push({ name: `parallel_${i}`, family: "parallel_independent", nodes });
  }

  for (let i = 0; i < 8; i++) {
    const nodes: TaskNode[] = [
      { id: `h_${i}_a`, dependsOn: [], estimatedTokens: 800 },
      { id: `h_${i}_b`, dependsOn: [], estimatedTokens: 850 },
      { id: `h_${i}_c`, dependsOn: [], estimatedTokens: 750 },
      { id: `h_${i}_synth`, dependsOn: [`h_${i}_a`, `h_${i}_b`, `h_${i}_c`], estimatedTokens: 1100 },
    ];
    scenarios.push({ name: `hybrid_${i}`, family: "hybrid_pipeline", nodes });
  }

  for (let i = 0; i < 8; i++) {
    const len = 4 + (i % 3);
    const nodes: TaskNode[] = [];
    for (let k = 0; k < len; k++) {
      nodes.push({
        id: `s_${i}_${k}`,
        dependsOn: k === 0 ? [] : [`s_${i}_${k - 1}`],
        estimatedTokens: 950 + k * 120,
      });
    }
    scenarios.push({ name: `sequential_${i}`, family: "sequential_coupled", nodes });
  }

  return scenarios;
}

function scoreSingleRun(
  scenario: WorkloadScenario,
  chosen: ExecutionTopology,
  rng: () => number,
): { success: boolean; tokens: number } {
  const analysis = analyzeTopology(scenario.nodes);
  const baseTokens = analysis.totalEstimatedTokens;

  // Empirical scaling dynamics from arXiv:2512.08296:
  // multi-agent fanout boosts parallelizable tasks, degrades tightly coupled sequential chains.
  let pSuccess = 0.78;
  let tokenMultiplier = 1.0;

  if (chosen === "single_agent") {
    pSuccess = scenario.family === "parallel_independent" ? 0.52 : 0.84;
    tokenMultiplier = 1.05;
  } else if (chosen === "parallel_fanout") {
    if (scenario.family === "parallel_independent") {
      pSuccess = 0.91;
      tokenMultiplier = 1.38;
    } else if (scenario.family === "hybrid_pipeline") {
      pSuccess = 0.62;
      tokenMultiplier = 1.72;
    } else {
      // Sequential chain forced into parallel handoffs suffers severe state-drift degradation.
      pSuccess = 0.27;
      tokenMultiplier = 2.45;
    }
  } else {
    pSuccess = scenario.family === "sequential_coupled" ? 0.44 : 0.86;
    tokenMultiplier = scenario.family === "sequential_coupled" ? 1.95 : 1.32;
  }

  const jitter = (rng() - 0.5) * 0.04;
  return {
    success: rng() < Math.min(0.99, Math.max(0.05, pSuccess + jitter)),
    tokens: Math.round(baseTokens * tokenMultiplier),
  };
}

export function runReplaySuite(
  workloads: WorkloadScenario[],
  strategy: ExecutionTopology | "auto_routed",
  seed = 42,
): SimulationOutcome {
  const rng = mulberry32(seed);
  let wins = 0;
  let totalTokens = 0;
  const routingLatenciesMs: number[] = [];

  for (const w of workloads) {
    const t0 = performance.now();
    const chosen = strategy === "auto_routed" ? analyzeTopology(w.nodes).topology : strategy;
    const t1 = performance.now();
    routingLatenciesMs.push(t1 - t0);

    const out = scoreSingleRun(w, chosen, rng);
    if (out.success) {
      wins += 1;
    }
    totalTokens += out.tokens;
  }

  routingLatenciesMs.sort((a, b) => a - b);
  const p95Idx = Math.min(routingLatenciesMs.length - 1, Math.floor(routingLatenciesMs.length * 0.95));

  return {
    strategy,
    accuracyRate: Number(((wins / workloads.length) * 100).toFixed(1)),
    avgTokens: Math.round(totalTokens / workloads.length),
    p95RoutingMs: Number((routingLatenciesMs[p95Idx] ?? 0).toFixed(4)),
  };
}

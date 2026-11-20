import { loadRecordedTraces, runReplaySuite } from "./replay.ts";
import { analyzeTopology, type TaskNode } from "./topology.ts";

function measureLargeDagRoutingMs(nodeCount: number): number {
  const nodes: TaskNode[] = [];
  for (let i = 0; i < nodeCount; i++) {
    nodes.push({
      id: `n_${i}`,
      dependsOn: i === 0 ? [] : [`n_${Math.floor((i - 1) / 2)}`],
      estimatedTokens: 500,
    });
  }
  const t0 = performance.now();
  analyzeTopology(nodes);
  return Number((performance.now() - t0).toFixed(4));
}

const dataset = loadRecordedTraces();
const strategies = ["single_agent", "parallel_fanout", "staged_pipeline", "auto_routed"] as const;

console.log("| Strategy | Accuracy (%) | Avg Tokens / Task | p95 Route Latency (ms) |");
console.log("|---|---|---|---|");
for (const strat of strategies) {
  const res = runReplaySuite(dataset, strat);
  console.log(`| ${res.strategy} | ${res.accuracyRate.toFixed(1)}% | ${res.avgTokens} | ${res.p95RoutingMs} ms |`);
}
console.log("");
console.log(`100-node DAG analysis: ${measureLargeDagRoutingMs(100)} ms`);
console.log(`1000-node DAG analysis: ${measureLargeDagRoutingMs(1000)} ms`);

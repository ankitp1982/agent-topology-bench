# agent-topology-bench

Tiny pre-execution DAG analyzer and trace replay benchmark for deciding when a workflow should run as a single agent, a parallel fan-out, or a staged pipeline.

Built in TypeScript on Node 24 with zero runtime dependencies (`node --test` and native type stripping).

## Why I Built This
After reading Google Research's paper on scaling agent systems (`arXiv:2512.08296`), one finding stood out: multi-agent setups improved parallelizable tasks significantly, yet degraded sequential planning tasks by up to 70% while multiplying token spend. Most agent frameworks hardcode the topology in application code regardless of the task graph.

I wanted to test a simple question in code: if we inspect the task dependency graph before making a single model call, how fast can we classify the workload and avoid forcing sequential chains into multi-agent fan-outs?

## Where the First Pass Broke
My first draft in `topology.ts` used a recursive `depthOf` helper. As soon as I fed it a task graph with a mutual dependency or an unknown `dependsOn` ID, it either blew the call stack or silently treated missing nodes as roots.

I replaced it with an explicit Kahn topological sort (`CyclicTaskGraphError`, `UnknownDependencyError`, `DuplicateNodeError`), which catches cycles and computes critical-path depth in `O(V + E)` without pulling in a graph library.

Another annoyance hit during testing: `replay.test.ts` initially compared the entire `SimulationOutcome` object with `assert.deepEqual`, which flaked on `p95RoutingMs` because V8 JIT warmup varies by fractions of a millisecond between runs. Separating deterministic simulation outputs (`accuracyRate`, `avgTokens`) from wall-clock timing fixed that.

## Running Locally
Requires Node.js 22.6+ or 24+ (tested on Node `v24.11.1` on macOS Apple Silicon):

```bash
node --test *.test.ts
node run_experiment.ts
# Optional: re-record traces/recorded_runs.json against gemini-3.5-flash-lite
GEMINI_API_KEY=... node trace_recorder.ts
```

Equivalent npm scripts are defined in `package.json` (`npm test`, `npm run bench`).

## Measured Results (9 Recorded `gemini-3.5-flash-lite` Engineering Workloads)
`run_experiment.ts` replays `traces/recorded_runs.json` across 9 software-engineering DAG workloads spanning parallel code/config security audits, hybrid incident triage and PR blast-radius synthesis, and sequential multi-hop auth/cache/deploy traces (`temperature: 0.1`, `maxOutputTokens: 256`, `maxConcurrency: 1` for `single_agent` and `4` for multi-node strategies):

| Strategy | Accuracy (%) | Avg Tokens / Task | p95 Route Latency (ms) |
|---|---|---|---|
| single_agent | 77.8% (7/9) | 350 | < 0.01 ms |
| parallel_fanout | 33.3% (3/9) | 471 | < 0.01 ms |
| staged_pipeline | 88.9% (8/9) | 629 | < 0.01 ms |
| auto_routed | 88.9% (8/9) | 567 | < 0.15 ms |

Large-graph scaling on Apple Silicon (`measureLargeDagRoutingMs` in `run_experiment.ts`):
- 100-node DAG analysis: `0.4208 ms`
- 1000-node DAG analysis: `0.668 ms`

Notes from the replay numbers:
- `auto_routed` matches `staged_pipeline` at `88.9%` (`8/9`) accuracy while averaging `567` tokens per task (`9.9%` fewer tokens than always running `staged_pipeline` at `629` tokens).
- `single_agent` uses the fewest tokens (`350`) but drops to `77.8%` (`7/9`) when bundling multiple code-audit snippets or hops into a single prompt.
- Forced `parallel_fanout` collapses to `33.3%` (`3/9`) because hybrid and sequential traces lose upstream context.
- Pre-flight structural routing (`analyzeTopology`) takes under `0.15 ms` p95 across the 9 recorded workloads.

## Tradeoffs, Caveats & Next Steps
- **Why zero external packages:** Keeping `topology.ts`, `scheduler.ts`, `trace_recorder.ts`, and `replay.ts` in pure TypeScript with Node's built-in test runner means zero `npm install` wait and sub-millisecond startup.
- **Caveat:** Assumes the task graph is known before execution. If an agent discovers new subtasks mid-flight via tool calls, the caller has to re-run `analyzeTopology` on the remaining subgraph.
- **Next up:**
  - Weight graph edges by `estimatedTokens` in `analyzeTopology` so wide fan-outs stay under per-minute rate limits.

## License
MIT

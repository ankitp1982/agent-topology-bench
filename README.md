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

## Measured Results (9 Recorded `gemini-3.5-flash-lite` Workloads)

| Strategy | Accuracy (%) | Avg Tokens / Task |
|---|---|---|
| single_agent | 77.8% | 446 |
| parallel_fanout | 33.3% | 743 |
| staged_pipeline | 77.8% | 772 |
| auto_routed | 88.9% | 564 |

Large-graph scaling on Apple Silicon:
- 100-node DAG analysis: `0.057 ms`
- 1000-node DAG analysis: `0.7339 ms`

The main takeaway for agent development: prompting harder does not fix a topology mismatch. Pre-flight structural routing takes under `0.02 ms` and cuts out the worst multi-agent token waste on sequential chains.

## Tradeoffs, Caveats & Next Steps
- **Why zero external packages:** Keeping `topology.ts`, `scheduler.ts`, `trace_recorder.ts`, and `replay.ts` in pure TypeScript with Node's built-in test runner means zero `npm install` wait and sub-millisecond startup.
- **Caveat:** Assumes the task graph is known before execution. If an agent discovers new subtasks mid-flight via tool calls, the caller has to re-run `analyzeTopology` on the remaining subgraph.
- **Next up:**
  - Weight graph edges by `estimatedTokens` in `analyzeTopology` so wide fan-outs stay under per-minute rate limits.

## License
MIT

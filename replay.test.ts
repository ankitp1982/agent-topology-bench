import assert from "node:assert/strict";
import test from "node:test";
import { buildBenchmarkWorkloads, runReplaySuite } from "./replay.ts";

test("replay suite is deterministic for a fixed seed", () => {
  const workloads = buildBenchmarkWorkloads();
  const a = runReplaySuite(workloads, "auto_routed", 42);
  const b = runReplaySuite(workloads, "auto_routed", 42);
  assert.equal(a.strategy, b.strategy);
  assert.equal(a.accuracyRate, b.accuracyRate);
  assert.equal(a.avgTokens, b.avgTokens);
  assert.ok(a.p95RoutingMs >= 0 && b.p95RoutingMs >= 0);
});

test("auto_routed outperforms forced parallel_fanout on mixed workloads", () => {
  const workloads = buildBenchmarkWorkloads();
  const autoRes = runReplaySuite(workloads, "auto_routed", 42);
  const forcedParallel = runReplaySuite(workloads, "parallel_fanout", 42);
  assert.ok(autoRes.accuracyRate > forcedParallel.accuracyRate);
  assert.ok(autoRes.avgTokens < forcedParallel.avgTokens);
});

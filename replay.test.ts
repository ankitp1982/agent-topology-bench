import assert from "node:assert/strict";
import test from "node:test";
import { MissingTraceError, extractAnswer, loadRecordedTraces, runReplaySuite, scoreRecordedRun } from "./replay.ts";
import { createGeminiGenerator, recordScenarioRun, type WorkloadScenario } from "./trace_recorder.ts";

test("replay suite is deterministic over recorded Gemini traces", () => {
  const dataset = loadRecordedTraces();
  const a = runReplaySuite(dataset, "auto_routed");
  const b = runReplaySuite(dataset, "auto_routed");
  assert.equal(a.strategy, b.strategy);
  assert.equal(a.accuracyRate, b.accuracyRate);
  assert.equal(a.avgTokens, b.avgTokens);
  assert.equal(a.scoredRuns, dataset.scenarios.length);
  assert.ok(a.p95RoutingMs >= 0 && b.p95RoutingMs >= 0);
});

test("auto_routed outperforms forced parallel_fanout on recorded workloads", () => {
  const dataset = loadRecordedTraces();
  const autoRes = runReplaySuite(dataset, "auto_routed");
  const forcedParallel = runReplaySuite(dataset, "parallel_fanout");
  assert.ok(autoRes.accuracyRate > forcedParallel.accuracyRate);
  assert.ok(autoRes.avgTokens < forcedParallel.avgTokens);
});

test("extractAnswer and scoreRecordedRun handle valid, multi-leaf, and faulty outputs", () => {
  assert.equal(extractAnswer("Reasoning...\nANSWER: 43."), "43");
  assert.equal(extractAnswer("ANSWER: 75 | ANSWER: 99"), "75,99");
  assert.equal(extractAnswer("No numbers here"), null);
  const base = { scenario: "x", strategy: "single_agent" as const, output: "ANSWER: 43", promptTokens: 10, completionTokens: 5, totalTokens: 15, status: "completed" as const, waves: 1, durationMs: 12 };
  assert.equal(scoreRecordedRun(base, "43"), true);
  assert.equal(scoreRecordedRun({ ...base, status: "partial_failure" }, "43"), false);
  assert.equal(scoreRecordedRun({ ...base, output: "broken" }, "43"), false);
});

test("replay rejects missing files and missing scenario traces", () => {
  assert.throws(() => loadRecordedTraces("/nonexistent/recorded_runs.json"));
  const dataset = loadRecordedTraces();
  assert.throws(() => runReplaySuite({ ...dataset, runs: [] }, "auto_routed"), MissingTraceError);
});

test("trace recorder executes strategies through scheduler and propagates API faults", async () => {
  assert.throws(() => createGeminiGenerator(""), /GEMINI_API_KEY/);
  const seq: WorkloadScenario = {
    name: "seq_t",
    family: "sequential_coupled",
    expected: "14",
    nodes: [
      { id: "s1", dependsOn: [], estimatedTokens: 100, prompt: "Start 5, add 2" },
      { id: "s2", dependsOn: ["s1"], estimatedTokens: 100, prompt: "Multiply by 2" },
    ],
  };
  const seenPrompts: string[] = [];
  const staged = await recordScenarioRun(seq, "staged_pipeline", async (p) => {
    seenPrompts.push(p);
    return { text: p.includes("s1:") ? "ANSWER: 14" : "ANSWER: 7", promptTokens: 20, completionTokens: 5, totalTokens: 25 };
  });
  assert.equal(staged.status, "completed");
  assert.equal(staged.waves, 2);
  assert.equal(staged.totalTokens, 50);
  assert.ok(seenPrompts[1]!.includes("s1: ANSWER: 7"));

  const faulted = await recordScenarioRun(seq, "staged_pipeline", async (p) => {
    if (p.includes("Start 5")) throw new Error("Gemini API error 429");
    return { text: "ANSWER: 0", promptTokens: 10, completionTokens: 2, totalTokens: 12 };
  });
  assert.equal(faulted.status, "partial_failure");
  assert.equal(faulted.output, "");
});

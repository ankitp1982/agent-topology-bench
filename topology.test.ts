import assert from "node:assert/strict";
import test from "node:test";
import { analyzeTopology, type TaskNode } from "./topology.ts";

test("selects parallel_fanout for independent subtasks", () => {
  const nodes: TaskNode[] = [
    { id: "fetch_docs", dependsOn: [], estimatedTokens: 800 },
    { id: "fetch_issues", dependsOn: [], estimatedTokens: 900 },
    { id: "fetch_prs", dependsOn: [], estimatedTokens: 750 },
  ];
  const res = analyzeTopology(nodes);
  assert.equal(res.topology, "parallel_fanout");
  assert.equal(res.maxDepth, 1);
});

test("selects single_agent for tightly coupled sequential chain", () => {
  const nodes: TaskNode[] = [
    { id: "plan", dependsOn: [], estimatedTokens: 1200 },
    { id: "schema", dependsOn: ["plan"], estimatedTokens: 1500 },
    { id: "codegen", dependsOn: ["schema"], estimatedTokens: 2000 },
    { id: "verify", dependsOn: ["codegen"], estimatedTokens: 900 },
  ];
  const res = analyzeTopology(nodes);
  assert.equal(res.topology, "single_agent");
  assert.equal(res.maxDepth, 4);
});

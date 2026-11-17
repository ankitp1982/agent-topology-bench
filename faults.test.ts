import assert from "node:assert/strict";
import test from "node:test";
import {
  CyclicTaskGraphError,
  DuplicateNodeError,
  UnknownDependencyError,
  analyzeTopology,
  type TaskNode,
} from "./topology.ts";

test("rejects cyclic dependency graphs", () => {
  const nodes: TaskNode[] = [
    { id: "a", dependsOn: ["b"], estimatedTokens: 500 },
    { id: "b", dependsOn: ["a"], estimatedTokens: 500 },
  ];
  assert.throws(() => analyzeTopology(nodes), CyclicTaskGraphError);
});

test("rejects unknown dependency references", () => {
  const nodes: TaskNode[] = [
    { id: "build", dependsOn: ["missing_spec"], estimatedTokens: 900 },
  ];
  assert.throws(() => analyzeTopology(nodes), UnknownDependencyError);
});

test("rejects duplicate task ids", () => {
  const nodes: TaskNode[] = [
    { id: "lint", dependsOn: [], estimatedTokens: 300 },
    { id: "lint", dependsOn: [], estimatedTokens: 400 },
  ];
  assert.throws(() => analyzeTopology(nodes), DuplicateNodeError);
});

test("rejects empty task graph", () => {
  assert.throws(() => analyzeTopology([]), /cannot be empty/);
});

test("computes critical-path depth on diamond dependency graph", () => {
  const nodes: TaskNode[] = [
    { id: "root", dependsOn: [], estimatedTokens: 600 },
    { id: "branch_a", dependsOn: ["root"], estimatedTokens: 700 },
    { id: "branch_b", dependsOn: ["root"], estimatedTokens: 700 },
    { id: "join", dependsOn: ["branch_a", "branch_b"], estimatedTokens: 800 },
  ];
  const res = analyzeTopology(nodes);
  assert.equal(res.maxDepth, 3);
  assert.equal(res.totalEstimatedTokens, 2800);
});

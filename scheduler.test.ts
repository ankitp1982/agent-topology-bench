import assert from "node:assert/strict";
import test from "node:test";
import { scheduleDag } from "./scheduler.ts";
import { CyclicTaskGraphError, type TaskNode } from "./topology.ts";

test("executes waves in topological order with bounded concurrency", async () => {
  const nodes: TaskNode[] = [
    { id: "root", dependsOn: [], estimatedTokens: 100 },
    { id: "b1", dependsOn: ["root"], estimatedTokens: 100 },
    { id: "b2", dependsOn: ["root"], estimatedTokens: 100 },
    { id: "b3", dependsOn: ["root"], estimatedTokens: 100 },
    { id: "join", dependsOn: ["b1", "b2", "b3"], estimatedTokens: 100 },
  ];
  let active = 0;
  let maxActive = 0;
  const order: string[] = [];
  const res = await scheduleDag<string>(nodes, async (node, ctx) => {
    maxActive = Math.max(maxActive, ++active);
    await new Promise((r) => setTimeout(r, 10));
    order.push(node.id);
    active -= 1;
    const deps = [...ctx.upstream.values()].join("+");
    return deps ? `${node.id}(${deps})` : node.id;
  }, { maxConcurrency: 2 });
  assert.equal(res.status, "completed");
  assert.equal(res.wavesExecuted, 3);
  assert.equal(maxActive, 2);
  assert.equal(order[0], "root");
  assert.equal(order[4], "join");
  assert.equal(res.outcomes.get("join")?.value, "join(b1(root)+b2(root)+b3(root))");
});

test("enforces token-bucket rate limit across tasks", async () => {
  const nodes: TaskNode[] = [
    { id: "t1", dependsOn: [], estimatedTokens: 100 },
    { id: "t2", dependsOn: [], estimatedTokens: 100 },
    { id: "t3", dependsOn: [], estimatedTokens: 100 },
  ];
  const t0 = performance.now();
  const res = await scheduleDag(nodes, async (n) => n.id, { maxConcurrency: 3, rateLimit: { capacity: 100, refillPerSecond: 2000 } });
  const elapsed = performance.now() - t0;
  assert.equal(res.status, "completed");
  assert.ok(elapsed >= 75, `Expected rate-limited duration >= 75ms, got ${elapsed}ms`);
});

test("propagates failures downstream while completing independent branches", async () => {
  const nodes: TaskNode[] = [
    { id: "root", dependsOn: [], estimatedTokens: 100 },
    { id: "fail_branch", dependsOn: ["root"], estimatedTokens: 100 },
    { id: "ok_branch", dependsOn: ["root"], estimatedTokens: 100 },
    { id: "leaf_a", dependsOn: ["fail_branch"], estimatedTokens: 100 },
    { id: "leaf_b", dependsOn: ["leaf_a"], estimatedTokens: 100 },
  ];
  const executed: string[] = [];
  const res = await scheduleDag(nodes, async (node) => {
    executed.push(node.id);
    if (node.id === "fail_branch") throw new Error("boom");
    return node.id;
  });
  assert.equal(res.status, "partial_failure");
  assert.equal(res.outcomes.get("ok_branch")?.status, "completed");
  assert.equal(res.outcomes.get("fail_branch")?.status, "failed");
  assert.equal(res.outcomes.get("leaf_a")?.status, "skipped");
  assert.equal(res.outcomes.get("leaf_b")?.status, "skipped");
  assert.ok(!executed.includes("leaf_a") && !executed.includes("leaf_b"));
});

test("supports pre-aborted and mid-flight AbortSignal cancellation", async () => {
  const nodes: TaskNode[] = [
    { id: "a", dependsOn: [], estimatedTokens: 100 },
    { id: "b", dependsOn: [], estimatedTokens: 100 },
    { id: "c", dependsOn: ["a"], estimatedTokens: 100 },
  ];
  const pre = new AbortController();
  pre.abort();
  const preRes = await scheduleDag(nodes, async (n) => n.id, { signal: pre.signal });
  assert.equal(preRes.status, "cancelled");
  assert.equal(preRes.wavesExecuted, 0);
  assert.equal(preRes.outcomes.get("a")?.status, "cancelled");

  const mid = new AbortController();
  const midRes = await scheduleDag(nodes, async (n) => {
    if (n.id === "a") mid.abort();
    return n.id;
  }, { maxConcurrency: 1, signal: mid.signal });
  assert.equal(midRes.status, "cancelled");
  assert.equal(midRes.outcomes.get("a")?.status, "completed");
  assert.equal(midRes.outcomes.get("b")?.status, "cancelled");
  assert.equal(midRes.outcomes.get("c")?.status, "cancelled");
});

test("rejects cyclic graphs and invalid scheduler options", async () => {
  const cyclic: TaskNode[] = [{ id: "x", dependsOn: ["y"], estimatedTokens: 50 }, { id: "y", dependsOn: ["x"], estimatedTokens: 50 }];
  await assert.rejects(() => scheduleDag(cyclic, async (n) => n.id), CyclicTaskGraphError);
  const single: TaskNode[] = [{ id: "ok", dependsOn: [], estimatedTokens: 500 }];
  await assert.rejects(() => scheduleDag(single, async (n) => n.id, { maxConcurrency: 0 }), RangeError);
  await assert.rejects(() => scheduleDag(single, async (n) => n.id, { rateLimit: { capacity: 100, refillPerSecond: 10 } }), RangeError);
});

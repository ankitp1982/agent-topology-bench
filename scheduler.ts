import { analyzeTopology, type TaskNode, type TopologyAnalysis } from "./topology.ts";

export type TaskStatus = "completed" | "failed" | "skipped" | "cancelled";
export interface TokenBucketConfig { capacity: number; refillPerSecond: number; }
export interface SchedulerOptions { maxConcurrency?: number; rateLimit?: TokenBucketConfig; signal?: AbortSignal; }
export interface TaskContext<T> { signal: AbortSignal; wave: number; upstream: ReadonlyMap<string, T>; }
export type TaskExecutor<T> = (node: TaskNode, ctx: TaskContext<T>) => Promise<T>;
export interface TaskOutcome<T> { id: string; wave: number; status: TaskStatus; value?: T; error?: Error; durationMs: number; }
export interface ScheduleResult<T> {
  analysis: TopologyAnalysis;
  status: "completed" | "partial_failure" | "cancelled";
  outcomes: Map<string, TaskOutcome<T>>;
  wavesExecuted: number;
}

function sleepWithSignal(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error("Cancelled"));
  return new Promise((resolve, reject) => {
    const onAbort = () => { clearTimeout(timer); reject(new Error("Cancelled")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

class TokenBucket {
  private tokens: number;
  private lastRefillMs = performance.now();
  private queue: Promise<void> = Promise.resolve();
  private readonly cfg: TokenBucketConfig;
  constructor(cfg: TokenBucketConfig) { this.cfg = cfg; this.tokens = cfg.capacity; }

  acquire(cost: number, signal: AbortSignal): Promise<void> {
    const need = Math.max(0, cost);
    const run = this.queue.then(async () => {
      while (true) {
        if (signal.aborted) throw new Error("Cancelled");
        const now = performance.now();
        this.tokens = Math.min(this.cfg.capacity, this.tokens + Math.max(0, (now - this.lastRefillMs) / 1000) * this.cfg.refillPerSecond);
        this.lastRefillMs = now;
        if (this.tokens >= need) { this.tokens -= need; return; }
        await sleepWithSignal(Math.max(1, Math.ceil(((need - this.tokens) / this.cfg.refillPerSecond) * 1000)), signal);
      }
    });
    this.queue = run.catch(() => {});
    return run;
  }
}

function buildWaves(nodes: TaskNode[]): TaskNode[][] {
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  const waveOf = new Map<string, number>();
  for (const n of nodes) { indegree.set(n.id, n.dependsOn.length); dependents.set(n.id, []); waveOf.set(n.id, 0); }
  for (const n of nodes) { for (const dep of n.dependsOn) dependents.get(dep)!.push(n.id); }
  const queue = nodes.filter((n) => n.dependsOn.length === 0).map((n) => n.id);
  for (let head = 0; head < queue.length; head++) {
    const curr = queue[head]!;
    const w = waveOf.get(curr) ?? 0;
    for (const nxt of dependents.get(curr) ?? []) {
      waveOf.set(nxt, Math.max(waveOf.get(nxt) ?? 0, w + 1));
      const rem = (indegree.get(nxt) ?? 1) - 1;
      indegree.set(nxt, rem);
      if (rem === 0) queue.push(nxt);
    }
  }
  const waves: TaskNode[][] = [];
  for (const n of nodes) (waves[waveOf.get(n.id) ?? 0] ??= []).push(n);
  return waves;
}

export async function scheduleDag<T>(nodes: TaskNode[], executor: TaskExecutor<T>, options: SchedulerOptions = {}): Promise<ScheduleResult<T>> {
  const analysis = analyzeTopology(nodes);
  const maxConcurrency = options.maxConcurrency ?? 4;
  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) throw new RangeError("maxConcurrency must be a positive integer");
  let bucket: TokenBucket | undefined;
  if (options.rateLimit) {
    const { capacity, refillPerSecond } = options.rateLimit;
    if (!(capacity > 0 && Number.isFinite(capacity)) || !(refillPerSecond > 0 && Number.isFinite(refillPerSecond))) {
      throw new RangeError("rateLimit capacity and refillPerSecond must be positive finite numbers");
    }
    for (const n of nodes) {
      if (Math.max(0, n.estimatedTokens) > capacity) throw new RangeError(`Task '${n.id}' estimatedTokens exceeds bucket capacity`);
    }
    bucket = new TokenBucket(options.rateLimit);
  }
  const controller = new AbortController();
  const onAbort = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) controller.abort(options.signal.reason);
  else options.signal?.addEventListener("abort", onAbort, { once: true });

  const outcomes = new Map<string, TaskOutcome<T>>();
  const mark = (id: string, wave: number, status: TaskStatus) => outcomes.set(id, { id, wave, status, durationMs: 0 });
  let wavesExecuted = 0;
  try {
    for (const [waveIdx, waveNodes] of buildWaves(nodes).entries()) {
      if (controller.signal.aborted) { for (const n of waveNodes) mark(n.id, waveIdx, "cancelled"); continue; }
      wavesExecuted += 1;
      const runnable: TaskNode[] = [];
      for (const n of waveNodes) {
        if (n.dependsOn.some((dep) => outcomes.get(dep)?.status !== "completed")) mark(n.id, waveIdx, "skipped");
        else runnable.push(n);
      }
      let cursor = 0;
      const workers = Array.from({ length: Math.min(maxConcurrency, runnable.length) }, async () => {
        while (!controller.signal.aborted) {
          const node = runnable[cursor++];
          if (!node) return;
          const t0 = performance.now();
          try {
            if (bucket) await bucket.acquire(node.estimatedTokens, controller.signal);
            if (controller.signal.aborted) { mark(node.id, waveIdx, "cancelled"); continue; }
            const upstream = new Map<string, T>();
            for (const dep of node.dependsOn) {
              const depOut = outcomes.get(dep);
              if (depOut?.status === "completed") upstream.set(dep, depOut.value as T);
            }
            const value = await executor(node, { signal: controller.signal, wave: waveIdx, upstream });
            outcomes.set(node.id, { id: node.id, wave: waveIdx, status: "completed", value, durationMs: Number((performance.now() - t0).toFixed(3)) });
          } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            outcomes.set(node.id, { id: node.id, wave: waveIdx, status: controller.signal.aborted ? "cancelled" : "failed", error, durationMs: Number((performance.now() - t0).toFixed(3)) });
          }
        }
      });
      await Promise.all(workers);
      for (const n of runnable) if (!outcomes.has(n.id)) mark(n.id, waveIdx, "cancelled");
    }
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
  }
  const hasFailure = [...outcomes.values()].some((o) => o.status === "failed" || o.status === "skipped");
  return { analysis, status: controller.signal.aborted ? "cancelled" : hasFailure ? "partial_failure" : "completed", outcomes, wavesExecuted };
}

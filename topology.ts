export type ExecutionTopology = "single_agent" | "parallel_fanout" | "staged_pipeline";

export interface TaskNode {
  id: string;
  dependsOn: string[];
  estimatedTokens: number;
}

export interface TopologyAnalysis {
  topology: ExecutionTopology;
  nodeCount: number;
  maxDepth: number;
  decomposability: number;
  sequentialCoupling: number;
  totalEstimatedTokens: number;
}

export class CyclicTaskGraphError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CyclicTaskGraphError";
  }
}

export class UnknownDependencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnknownDependencyError";
  }
}

export class DuplicateNodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DuplicateNodeError";
  }
}

export function analyzeTopology(nodes: TaskNode[]): TopologyAnalysis {
  if (nodes.length === 0) {
    throw new Error("Task graph cannot be empty");
  }

  const byId = new Map<string, TaskNode>();
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  for (const node of nodes) {
    if (byId.has(node.id)) {
      throw new DuplicateNodeError(`Duplicate task node id: ${node.id}`);
    }
    byId.set(node.id, node);
    indegree.set(node.id, 0);
    dependents.set(node.id, []);
  }

  for (const node of nodes) {
    for (const dep of node.dependsOn) {
      if (!byId.has(dep)) {
        throw new UnknownDependencyError(`Task '${node.id}' depends on unknown task '${dep}'`);
      }
      dependents.get(dep)!.push(node.id);
      indegree.set(node.id, (indegree.get(node.id) ?? 0) + 1);
    }
  }

  // Why Kahn's queue instead of recursive depthOf: avoids stack overflow on deep chains and rejects cycles in O(V+E).
  const queue: string[] = [];
  const depth = new Map<string, number>();
  for (const [id, deg] of indegree.entries()) {
    if (deg === 0) {
      queue.push(id);
      depth.set(id, 1);
    }
  }

  let visited = 0;
  let head = 0;
  while (head < queue.length) {
    const curr = queue[head++]!;
    visited += 1;
    const currDepth = depth.get(curr) ?? 1;
    for (const nxt of dependents.get(curr) ?? []) {
      const prevDepth = depth.get(nxt) ?? 1;
      if (currDepth + 1 > prevDepth) {
        depth.set(nxt, currDepth + 1);
      }
      const nextDeg = (indegree.get(nxt) ?? 1) - 1;
      indegree.set(nxt, nextDeg);
      if (nextDeg === 0) {
        queue.push(nxt);
      }
    }
  }

  if (visited !== nodes.length) {
    throw new CyclicTaskGraphError("Cycle detected in task dependency graph");
  }

  const maxDepth = Math.max(...depth.values());
  const independentCount = nodes.filter((n) => n.dependsOn.length === 0).length;
  const decomposability = Number((independentCount / nodes.length).toFixed(3));
  const sequentialCoupling = Number(((maxDepth - 1) / Math.max(1, nodes.length - 1)).toFixed(3));
  const totalEstimatedTokens = nodes.reduce((acc, n) => acc + Math.max(0, n.estimatedTokens), 0);

  let topology: ExecutionTopology = "single_agent";
  if (maxDepth === 1 && nodes.length > 1) {
    topology = "parallel_fanout";
  } else if (decomposability >= 0.45 && sequentialCoupling <= 0.65 && nodes.length >= 4) {
    topology = "staged_pipeline";
  }

  return {
    topology,
    nodeCount: nodes.length,
    maxDepth,
    decomposability,
    sequentialCoupling,
    totalEstimatedTokens,
  };
}

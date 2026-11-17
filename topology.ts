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
}

export function analyzeTopology(nodes: TaskNode[]): TopologyAnalysis {
  if (nodes.length === 0) {
    throw new Error("Task graph cannot be empty");
  }

  const byId = new Map<string, TaskNode>();
  for (const node of nodes) {
    byId.set(node.id, node);
  }

  const depthOf = (id: string): number => {
    const node = byId.get(id);
    if (!node || node.dependsOn.length === 0) {
      return 1;
    }
    return 1 + Math.max(...node.dependsOn.map((dep) => depthOf(dep)));
  };

  const maxDepth = Math.max(...nodes.map((n) => depthOf(n.id)));
  const independentCount = nodes.filter((n) => n.dependsOn.length === 0).length;
  const decomposability = Number((independentCount / nodes.length).toFixed(3));

  let topology: ExecutionTopology = "single_agent";
  if (maxDepth === 1 && nodes.length > 1) {
    topology = "parallel_fanout";
  } else if (decomposability >= 0.45 && nodes.length >= 4) {
    topology = "staged_pipeline";
  }

  return {
    topology,
    nodeCount: nodes.length,
    maxDepth,
    decomposability,
  };
}

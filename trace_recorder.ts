import { writeFileSync } from "node:fs";
import { scheduleDag } from "./scheduler.ts";
import { type ExecutionTopology, type TaskNode } from "./topology.ts";

export const GEMINI_MODEL = "gemini-3.5-flash-lite";
export interface PromptTaskNode extends TaskNode { prompt: string; }
export interface WorkloadScenario {
  name: string;
  family: "parallel_independent" | "hybrid_pipeline" | "sequential_coupled";
  expected: string;
  nodes: PromptTaskNode[];
}
export interface RecordedRun {
  scenario: string;
  strategy: ExecutionTopology;
  output: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  status: "completed" | "partial_failure" | "cancelled";
  waves: number;
  durationMs: number;
}
export interface RecordedDataset { model: string; recordedAt: string; scenarios: WorkloadScenario[]; runs: RecordedRun[]; }
export interface ModelResponse { text: string; promptTokens: number; completionTokens: number; totalTokens: number; }
export type ModelGenerateFn = (prompt: string, signal: AbortSignal) => Promise<ModelResponse>;

export function createGeminiGenerator(apiKey = process.env.GEMINI_API_KEY): ModelGenerateFn {
  if (!apiKey) throw new Error("GEMINI_API_KEY is required to record live Gemini traces");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;
  return async (prompt, signal) => {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal,
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.1, maxOutputTokens: 256 } }),
    });
    if (!resp.ok) throw new Error(`Gemini API error ${resp.status}: ${await resp.text()}`);
    const data = (await resp.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
    };
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error("Gemini API returned empty candidate text");
    const promptTokens = data.usageMetadata?.promptTokenCount ?? 0;
    const completionTokens = data.usageMetadata?.candidatesTokenCount ?? 0;
    return { text: text.trim(), promptTokens, completionTokens, totalTokens: data.usageMetadata?.totalTokenCount ?? promptTokens + completionTokens };
  };
}

function planNodes(scenario: WorkloadScenario, strategy: ExecutionTopology): PromptTaskNode[] {
  if (strategy === "single_agent") {
    const prompt = ["Solve all steps in order and end with ANSWER: <value>.", ...scenario.nodes.map((n, i) => `Step ${i + 1} (${n.id}): ${n.prompt}`)].join("\n");
    return [{ id: `${scenario.name}_single`, dependsOn: [], estimatedTokens: scenario.nodes.reduce((a, n) => a + n.estimatedTokens, 0), prompt }];
  }
  return strategy === "parallel_fanout" ? scenario.nodes.map((n) => ({ ...n, dependsOn: [] })) : scenario.nodes;
}

export async function recordScenarioRun(scenario: WorkloadScenario, strategy: ExecutionTopology, generate: ModelGenerateFn): Promise<RecordedRun> {
  const planned = planNodes(scenario, strategy);
  const byId = new Map(planned.map((n) => [n.id, n]));
  let promptTokens = 0, completionTokens = 0, totalTokens = 0;
  const t0 = performance.now();
  const res = await scheduleDag<string>(planned, async (node, ctx) => {
    const up = [...ctx.upstream.entries()].map(([id, v]) => `${id}: ${v}`).join("\n");
    const prompt = up ? `Upstream results:\n${up}\n\nTask: ${byId.get(node.id)!.prompt}\nEnd with ANSWER: <value>.` : `${byId.get(node.id)!.prompt}\nEnd with ANSWER: <value>.`;
    const reply = await generate(prompt, ctx.signal);
    promptTokens += reply.promptTokens;
    completionTokens += reply.completionTokens;
    totalTokens += reply.totalTokens;
    return reply.text;
  }, { maxConcurrency: strategy === "single_agent" ? 1 : 4 });
  const depTargets = new Set(planned.flatMap((n) => n.dependsOn));
  const output = planned.filter((n) => !depTargets.has(n.id)).map((n) => res.outcomes.get(n.id)?.value ?? "").filter(Boolean).join(" | ");
  return { scenario: scenario.name, strategy, output, promptTokens, completionTokens, totalTokens, status: res.status, waves: res.wavesExecuted, durationMs: Math.round(performance.now() - t0) };
}

export async function recordAllTraces(scenarios: WorkloadScenario[], generate: ModelGenerateFn, outPath?: string | URL): Promise<RecordedDataset> {
  const strategies: ExecutionTopology[] = ["single_agent", "parallel_fanout", "staged_pipeline"];
  const runs: RecordedRun[] = [];
  for (const s of scenarios) for (const st of strategies) runs.push(await recordScenarioRun(s, st, generate));
  const dataset: RecordedDataset = { model: GEMINI_MODEL, recordedAt: new Date().toISOString(), scenarios, runs };
  if (outPath) writeFileSync(outPath, `${JSON.stringify(dataset, null, 2)}\n`, "utf8");
  return dataset;
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"));
if (isMain) {
  const { loadRecordedTraces } = await import("./replay.ts");
  const out = new URL("./traces/recorded_runs.json", import.meta.url);
  const res = await recordAllTraces(loadRecordedTraces(out).scenarios, createGeminiGenerator(), out);
  console.log(`Recorded ${res.runs.length} runs against ${res.model}`);
}

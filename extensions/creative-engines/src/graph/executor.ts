import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EngineRuntime } from "../runtime/engine-runtime.js";
import type { Graph, GraphNode, GraphResult, NodeResult } from "./types.js";

/**
 * PipelineExecutor: topological sort, cycle detection, execute nodes
 * in dependency order through engine runtimes.
 * Failure isolation: a failed node causes dependents to be skipped, not aborted.
 */
export class PipelineExecutor {
  private engines: Record<string, EngineRuntime>;

  constructor(engines: Record<string, EngineRuntime>) {
    this.engines = engines;
  }

  async execute(graph: Graph): Promise<GraphResult> {
    const sorted = this.topologicalSort(graph);
    const startTime = Date.now();
    const results: NodeResult[] = [];
    const outputMap = new Map<string, string>(); // nodeId → output path
    const failedNodes = new Set<string>();

    for (const node of sorted) {
      // Check if any dependency failed → skip
      const deps = this.getDependencies(graph, node.id);
      const shouldSkip = deps.some((depId) => failedNodes.has(depId));

      if (shouldSkip) {
        failedNodes.add(node.id);
        results.push({ node_id: node.id, status: "skipped" });
        continue;
      }

      const result = await this.executeNode(node, graph, outputMap);
      results.push(result);

      if (result.status === "failed") {
        failedNodes.add(node.id);
      } else if (result.output_path) {
        outputMap.set(node.id, result.output_path);
      }
    }

    const totalDuration = Date.now() - startTime;
    const allOk = results.every((r) => r.status === "ok");

    return {
      graph_id: graph.id,
      ok: allOk,
      nodes: results,
      total_duration_ms: totalDuration,
    };
  }

  private async executeNode(
    node: GraphNode,
    graph: Graph,
    outputMap: Map<string, string>,
  ): Promise<NodeResult> {
    const engine = this.engines[node.engine];
    if (!engine) {
      return { node_id: node.id, status: "failed", error: `No engine available: ${node.engine}` };
    }

    if (!engine.isAvailable()) {
      return { node_id: node.id, status: "failed", error: `Engine '${node.engine}' is not available` };
    }

    // Resolve input: from connection or explicit
    const inputPath = this.resolveInput(node, graph, outputMap);
    if (!inputPath) {
      return { node_id: node.id, status: "failed", error: "No input path resolved" };
    }

    const outputPath = node.output ?? join(tmpdir(), `graph_${graph.id}_${node.id}_output`);

    const start = Date.now();
    try {
      const result = await engine.apply(inputPath, node.op, outputPath, node.params);
      const duration = Date.now() - start;

      if (!result.ok) {
        return { node_id: node.id, status: "failed", duration_ms: duration, error: result.reason };
      }

      return { node_id: node.id, status: "ok", output_path: result.output_path, duration_ms: duration };
    } catch (err) {
      const duration = Date.now() - start;
      const message = err instanceof Error ? err.message : String(err);
      return { node_id: node.id, status: "failed", duration_ms: duration, error: message };
    }
  }

  private resolveInput(node: GraphNode, graph: Graph, outputMap: Map<string, string>): string | undefined {
    // Check connections for an input to this node
    const conn = graph.connections.find((c) => c.to_node === node.id);
    if (conn) {
      return outputMap.get(conn.from_node);
    }
    return node.input;
  }

  private getDependencies(graph: Graph, nodeId: string): string[] {
    return graph.connections.filter((c) => c.to_node === nodeId).map((c) => c.from_node);
  }

  /**
   * Topological sort with cycle detection using Kahn's algorithm.
   */
  private topologicalSort(graph: Graph): GraphNode[] {
    const nodeMap = new Map(graph.nodes.map((n) => [n.id, n]));
    const inDegree = new Map<string, number>();
    const adjacency = new Map<string, string[]>();

    for (const node of graph.nodes) {
      inDegree.set(node.id, 0);
      adjacency.set(node.id, []);
    }

    for (const conn of graph.connections) {
      adjacency.get(conn.from_node)?.push(conn.to_node);
      inDegree.set(conn.to_node, (inDegree.get(conn.to_node) ?? 0) + 1);
    }

    const queue: string[] = [];
    for (const [id, degree] of inDegree) {
      if (degree === 0) queue.push(id);
    }

    const sorted: GraphNode[] = [];

    while (queue.length > 0) {
      const current = queue.shift()!;
      const node = nodeMap.get(current);
      if (node) sorted.push(node);

      for (const neighbor of adjacency.get(current) ?? []) {
        const newDegree = (inDegree.get(neighbor) ?? 1) - 1;
        inDegree.set(neighbor, newDegree);
        if (newDegree === 0) queue.push(neighbor);
      }
    }

    if (sorted.length !== graph.nodes.length) {
      throw new Error(`Cycle detected in graph '${graph.id}': cannot execute`);
    }

    return sorted;
  }
}

/** A node in a processing graph. */
export interface GraphNode {
  id: string;
  engine: "image" | "audio" | "video" | "vector";
  op: string;
  params: Record<string, unknown>;
  /** Input file path or reference to another node's output. */
  input?: string;
  /** Output file path. If omitted, a temp path is generated. */
  output?: string;
}

/** A directed connection between two nodes in the graph. */
export interface Connection {
  from_node: string;
  from_output: string;
  to_node: string;
  to_input: string;
}

/** A complete processing graph definition. */
export interface Graph {
  id: string;
  nodes: GraphNode[];
  connections: Connection[];
}

/** Status of a single node after execution. */
export type NodeStatus = "ok" | "failed" | "skipped";

/** Result of executing a single graph node. */
export interface NodeResult {
  node_id: string;
  status: NodeStatus;
  output_path?: string;
  duration_ms?: number;
  error?: string;
}

/** Result of executing an entire graph. */
export interface GraphResult {
  graph_id: string;
  ok: boolean;
  nodes: NodeResult[];
  total_duration_ms: number;
}

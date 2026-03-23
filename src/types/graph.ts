export interface GraphNode {
  id: string;
  label: string;
  metadata?: Record<string, unknown>;
}

export interface GraphEdge {
  from: string;
  to: string;
  weight?: number;
}

export interface CycleResult {
  cycles: string[][];
  hasCycles: boolean;
  summary: string;
}

export interface GraphStats {
  nodeCount: number;
  edgeCount: number;
  fanIn: Map<string, number>;
  fanOut: Map<string, number>;
}

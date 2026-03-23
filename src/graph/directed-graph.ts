import type { CycleResult, GraphStats } from "../types/graph.js";

export class DirectedGraph {
  private adjacency = new Map<string, Set<string>>();

  addNode(node: string): void {
    if (!this.adjacency.has(node)) {
      this.adjacency.set(node, new Set());
    }
  }

  addEdge(from: string, to: string): void {
    this.addNode(from);
    this.addNode(to);
    this.adjacency.get(from)!.add(to);
  }

  getNodes(): string[] {
    return [...this.adjacency.keys()];
  }

  getNeighbors(node: string): Set<string> {
    return this.adjacency.get(node) ?? new Set();
  }

  /**
   * Tarjan's Strongly Connected Components algorithm.
   * Returns groups of nodes that form cycles.
   */
  findStronglyConnectedComponents(): string[][] {
    let index = 0;
    const stack: string[] = [];
    const onStack = new Set<string>();
    const indices = new Map<string, number>();
    const lowLinks = new Map<string, number>();
    const result: string[][] = [];

    const strongConnect = (v: string) => {
      indices.set(v, index);
      lowLinks.set(v, index);
      index++;
      stack.push(v);
      onStack.add(v);

      for (const w of this.getNeighbors(v)) {
        if (!indices.has(w)) {
          strongConnect(w);
          lowLinks.set(v, Math.min(lowLinks.get(v)!, lowLinks.get(w)!));
        } else if (onStack.has(w)) {
          lowLinks.set(v, Math.min(lowLinks.get(v)!, indices.get(w)!));
        }
      }

      if (lowLinks.get(v) === indices.get(v)) {
        const component: string[] = [];
        let w: string;
        do {
          w = stack.pop()!;
          onStack.delete(w);
          component.push(w);
        } while (w !== v);
        result.push(component);
      }
    };

    for (const node of this.adjacency.keys()) {
      if (!indices.has(node)) {
        strongConnect(node);
      }
    }

    return result;
  }

  /**
   * Find all cycles (SCCs with size > 1).
   */
  findCycles(): CycleResult {
    const sccs = this.findStronglyConnectedComponents();
    const cycles = sccs.filter((scc) => {
      if (scc.length > 1) return true;
      // Single node with self-loop
      if (scc.length === 1 && this.getNeighbors(scc[0]).has(scc[0])) return true;
      return false;
    });

    const summary = cycles.length === 0
      ? "No circular dependencies detected."
      : `Found ${cycles.length} circular dependency group(s) involving ${cycles.reduce((sum, c) => sum + c.length, 0)} modules.`;

    return { cycles, hasCycles: cycles.length > 0, summary };
  }

  /**
   * Topological sort. Returns null if cycles exist.
   */
  topologicalSort(): string[] | null {
    const inDegree = new Map<string, number>();
    for (const node of this.adjacency.keys()) {
      inDegree.set(node, 0);
    }
    for (const [, neighbors] of this.adjacency) {
      for (const n of neighbors) {
        inDegree.set(n, (inDegree.get(n) ?? 0) + 1);
      }
    }

    const queue: string[] = [];
    for (const [node, deg] of inDegree) {
      if (deg === 0) queue.push(node);
    }

    const sorted: string[] = [];
    while (queue.length > 0) {
      const node = queue.shift()!;
      sorted.push(node);
      for (const neighbor of this.getNeighbors(node)) {
        const newDeg = inDegree.get(neighbor)! - 1;
        inDegree.set(neighbor, newDeg);
        if (newDeg === 0) queue.push(neighbor);
      }
    }

    return sorted.length === this.adjacency.size ? sorted : null;
  }

  getStats(): GraphStats {
    const fanIn = new Map<string, number>();
    const fanOut = new Map<string, number>();

    for (const node of this.adjacency.keys()) {
      fanIn.set(node, 0);
      fanOut.set(node, this.getNeighbors(node).size);
    }
    for (const [, neighbors] of this.adjacency) {
      for (const n of neighbors) {
        fanIn.set(n, (fanIn.get(n) ?? 0) + 1);
      }
    }

    return {
      nodeCount: this.adjacency.size,
      edgeCount: [...this.adjacency.values()].reduce((sum, s) => sum + s.size, 0),
      fanIn,
      fanOut,
    };
  }

  toMermaid(): string {
    const lines = ["graph TD"];
    for (const [from, neighbors] of this.adjacency) {
      if (neighbors.size === 0) {
        lines.push(`  ${sanitizeMermaid(from)}`);
      }
      for (const to of neighbors) {
        lines.push(`  ${sanitizeMermaid(from)} --> ${sanitizeMermaid(to)}`);
      }
    }
    return lines.join("\n");
  }

  toDot(): string {
    const lines = ["digraph Dependencies {", "  rankdir=LR;"];
    for (const [from, neighbors] of this.adjacency) {
      for (const to of neighbors) {
        lines.push(`  "${from}" -> "${to}";`);
      }
    }
    lines.push("}");
    return lines.join("\n");
  }

  toAdjacencyList(): Record<string, string[]> {
    const result: Record<string, string[]> = {};
    for (const [node, neighbors] of this.adjacency) {
      result[node] = [...neighbors].sort();
    }
    return result;
  }
}

function sanitizeMermaid(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, "_");
}

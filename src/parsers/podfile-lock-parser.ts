import { readFile } from "node:fs/promises";
import type { DependencyNode } from "../types/analysis.js";

interface PodInfo {
  name: string;
  version: string;
  dependencies: string[];
}

/**
 * Parse Podfile.lock to extract pod dependency tree.
 * Podfile.lock uses a YAML-like format with specific indentation rules.
 */
export async function parsePodfileLock(
  filePath: string,
): Promise<{ pods: PodInfo[]; directDeps: string[] }> {
  const source = await readFile(filePath, "utf-8");
  return parsePodfileLockSource(source);
}

export function parsePodfileLockSource(
  source: string,
): { pods: PodInfo[]; directDeps: string[] } {
  const pods: PodInfo[] = [];
  const directDeps: string[] = [];

  const sections = splitSections(source);

  // Parse PODS section
  if (sections.PODS) {
    const podsLines = sections.PODS.split("\n");
    let currentPod: PodInfo | null = null;

    for (const line of podsLines) {
      // Top-level pod: "  - PodName (1.0.0):"
      const podMatch = line.match(/^  - ([^\s(]+)\s*\(([^)]+)\):?\s*$/);
      if (podMatch) {
        if (currentPod) pods.push(currentPod);
        currentPod = {
          name: podMatch[1],
          version: podMatch[2],
          dependencies: [],
        };
        continue;
      }

      // Sub-dependency: "    - DependencyName (= 1.0.0)" or "    - DependencyName"
      const depMatch = line.match(/^    - ([^\s(]+)/);
      if (depMatch && currentPod) {
        currentPod.dependencies.push(depMatch[1]);
      }
    }
    if (currentPod) pods.push(currentPod);
  }

  // Parse DEPENDENCIES section
  if (sections.DEPENDENCIES) {
    const depLines = sections.DEPENDENCIES.split("\n");
    for (const line of depLines) {
      const match = line.match(/^  - ([^\s(]+)/);
      if (match) {
        directDeps.push(match[1]);
      }
    }
  }

  return { pods, directDeps };
}

function splitSections(source: string): Record<string, string> {
  const sections: Record<string, string> = {};
  let currentSection = "";
  let currentContent: string[] = [];

  for (const line of source.split("\n")) {
    // Section header: no leading whitespace, ends with ':'
    if (/^[A-Z][A-Z\s]*:/.test(line)) {
      if (currentSection) {
        sections[currentSection] = currentContent.join("\n");
      }
      currentSection = line.replace(":", "").trim();
      currentContent = [];
    } else {
      currentContent.push(line);
    }
  }

  if (currentSection) {
    sections[currentSection] = currentContent.join("\n");
  }

  return sections;
}

/**
 * Build a dependency tree from parsed pod info.
 */
export function buildPodDependencyTree(
  pods: PodInfo[],
  directDeps: string[],
): DependencyNode[] {
  const podMap = new Map(pods.map((p) => [p.name, p]));

  function buildNode(name: string, isTransitive: boolean, visited: Set<string>): DependencyNode {
    const pod = podMap.get(name);
    const children: DependencyNode[] = [];

    if (pod && !visited.has(name)) {
      visited.add(name);
      for (const dep of pod.dependencies) {
        children.push(buildNode(dep, true, visited));
      }
    }

    return {
      name,
      version: pod?.version,
      isTransitive,
      children,
    };
  }

  return directDeps.map((name) => buildNode(name, false, new Set()));
}

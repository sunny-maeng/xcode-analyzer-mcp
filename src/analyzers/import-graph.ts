import { scanSwiftFiles } from "../utils/file-scanner.js";
import { parseImportsFromFiles, getUniqueModules } from "../parsers/swift-import-parser.js";
import { DirectedGraph } from "../graph/directed-graph.js";
import { formatTable } from "../utils/formatter.js";

export interface ImportGraphOptions {
  projectPath: string;
  outputFormat?: "adjacency_list" | "matrix" | "mermaid" | "dot";
  includeSystemFrameworks?: boolean;
  excludePatterns?: string[];
}

const SYSTEM_FRAMEWORKS = new Set([
  "Foundation", "UIKit", "SwiftUI", "Combine", "CoreData", "CoreGraphics",
  "CoreImage", "CoreLocation", "CoreMotion", "CoreText", "MapKit",
  "AVFoundation", "AVKit", "WebKit", "SafariServices", "StoreKit",
  "GameKit", "SpriteKit", "SceneKit", "RealityKit", "ARKit",
  "HealthKit", "HomeKit", "CloudKit", "CoreBluetooth", "CoreNFC",
  "CoreML", "Vision", "NaturalLanguage", "Speech", "MediaPlayer",
  "PhotosUI", "Photos", "MessageUI", "EventKit", "EventKitUI",
  "Contacts", "ContactsUI", "UserNotifications", "NetworkExtension",
  "CryptoKit", "AuthenticationServices", "LocalAuthentication",
  "os", "Darwin", "Dispatch", "ObjectiveC", "Swift", "Accessibility",
  "_Concurrency", "_StringProcessing", "RegexBuilder",
]);

export async function analyzeImportGraph(options: ImportGraphOptions): Promise<string> {
  const {
    projectPath,
    outputFormat = "adjacency_list",
    includeSystemFrameworks = false,
    excludePatterns = [],
  } = options;

  const swiftFiles = await scanSwiftFiles(projectPath, excludePatterns);
  const importMap = await parseImportsFromFiles(swiftFiles);

  // Determine which modules are "local" (defined in this project)
  // by inferring from directory structure
  const allModules = getUniqueModules(importMap);
  const localModules = new Set(
    includeSystemFrameworks
      ? allModules
      : allModules.filter((m) => !SYSTEM_FRAMEWORKS.has(m)),
  );

  // Build module-level dependency graph
  const graph = new DirectedGraph();

  // Try to infer file-to-module mapping from directory structure
  const fileModuleMap = inferFileModuleMap(swiftFiles, projectPath);

  for (const [filePath, imports] of importMap) {
    const sourceModule = fileModuleMap.get(filePath) ?? "Unknown";
    graph.addNode(sourceModule);

    for (const imp of imports) {
      if (!includeSystemFrameworks && SYSTEM_FRAMEWORKS.has(imp.module)) continue;
      if (sourceModule !== imp.module) {
        graph.addEdge(sourceModule, imp.module);
      }
    }
  }

  // Generate output
  const stats = graph.getStats();
  const lines: string[] = [];

  lines.push(`## Import Dependency Graph`);
  lines.push(`- **Modules:** ${stats.nodeCount}`);
  lines.push(`- **Dependencies:** ${stats.edgeCount}\n`);

  // Fan-in/fan-out stats
  lines.push("### Module Statistics");
  const modules = graph.getNodes().sort();
  const statRows = modules.map((m) => [
    m,
    String(stats.fanOut.get(m) ?? 0),
    String(stats.fanIn.get(m) ?? 0),
  ]);
  lines.push(formatTable(["Module", "Depends On (fan-out)", "Depended By (fan-in)"], statRows));

  // Graph representation
  lines.push(`\n### Graph (${outputFormat})`);
  switch (outputFormat) {
    case "mermaid":
      lines.push("```mermaid");
      lines.push(graph.toMermaid());
      lines.push("```");
      break;
    case "dot":
      lines.push("```dot");
      lines.push(graph.toDot());
      lines.push("```");
      break;
    case "matrix":
      lines.push(generateMatrix(graph));
      break;
    case "adjacency_list":
    default:
      lines.push("```");
      const adj = graph.toAdjacencyList();
      for (const [node, deps] of Object.entries(adj)) {
        lines.push(`${node} → ${deps.length > 0 ? deps.join(", ") : "(none)"}`);
      }
      lines.push("```");
      break;
  }

  return lines.join("\n");
}

/**
 * Infer which module a Swift file belongs to based on directory structure.
 * Common patterns: Sources/ModuleName/..., Modules/ModuleName/...
 */
function inferFileModuleMap(
  filePaths: string[],
  projectPath: string,
): Map<string, string> {
  const map = new Map<string, string>();

  for (const filePath of filePaths) {
    const relative = filePath.replace(projectPath + "/", "");
    const parts = relative.split("/");

    // Pattern: Sources/ModuleName/...
    const srcIdx = parts.findIndex((p) => p === "Sources" || p === "Source");
    if (srcIdx !== -1 && parts.length > srcIdx + 1) {
      map.set(filePath, parts[srcIdx + 1]);
      continue;
    }

    // Pattern: Modules/ModuleName/...
    const modIdx = parts.findIndex((p) => p === "Modules" || p === "Features");
    if (modIdx !== -1 && parts.length > modIdx + 1) {
      map.set(filePath, parts[modIdx + 1]);
      continue;
    }

    // Fallback: use first meaningful directory
    if (parts.length >= 2) {
      map.set(filePath, parts[0]);
    } else {
      map.set(filePath, "Root");
    }
  }

  return map;
}

function generateMatrix(graph: DirectedGraph): string {
  const nodes = graph.getNodes().sort();
  if (nodes.length > 50) {
    return "(Matrix too large — use adjacency_list or mermaid format for large projects)";
  }

  const header = ["", ...nodes];
  const rows = nodes.map((from) => {
    const neighbors = graph.getNeighbors(from);
    return [from, ...nodes.map((to) => (neighbors.has(to) ? "●" : "·"))];
  });

  return formatTable(header, rows);
}

import { scanSwiftFiles } from "../utils/file-scanner.js";
import { parseImportsFromFiles } from "../parsers/swift-import-parser.js";
import { parsePackageSwift } from "../parsers/package-swift-parser.js";
import { DirectedGraph } from "../graph/directed-graph.js";
import { detectProject } from "../utils/project-detector.js";
import { access } from "node:fs/promises";

export interface CircularDependencyOptions {
  projectPath: string;
  level?: "module" | "file";
  excludePatterns?: string[];
}

const SYSTEM_FRAMEWORKS = new Set([
  "Foundation", "UIKit", "SwiftUI", "Combine", "CoreData", "CoreGraphics",
  "CoreImage", "CoreLocation", "MapKit", "AVFoundation", "WebKit",
  "SafariServices", "StoreKit", "HealthKit", "CloudKit", "CoreBluetooth",
  "CoreML", "Vision", "Photos", "PhotosUI", "UserNotifications",
  "CryptoKit", "AuthenticationServices", "LocalAuthentication",
  "os", "Darwin", "Dispatch", "ObjectiveC", "Swift", "Accessibility",
]);

export async function analyzeCircularDependencies(
  options: CircularDependencyOptions,
): Promise<string> {
  const { projectPath, level = "module", excludePatterns = [] } = options;

  const graph = new DirectedGraph();

  // Strategy 1: Parse Package.swift for SPM target dependencies
  const project = await detectProject(projectPath);
  if (project.packageSwiftPath) {
    try {
      const pkg = await parsePackageSwift(project.packageSwiftPath);
      for (const target of pkg.targets) {
        graph.addNode(target.name);
        for (const dep of target.dependencies) {
          graph.addEdge(target.name, dep.name);
        }
      }
    } catch {
      // Package.swift parsing failed, continue with import analysis
    }
  }

  // Strategy 2: Parse Swift imports for module/file level dependencies
  const swiftFiles = await scanSwiftFiles(projectPath, excludePatterns);
  const importMap = await parseImportsFromFiles(swiftFiles);

  if (level === "file") {
    // File-level analysis
    for (const [filePath, imports] of importMap) {
      const shortPath = filePath.replace(projectPath + "/", "");
      graph.addNode(shortPath);
      // For file-level, we can only detect module-level imports
      // True file-to-file deps would need compiler analysis
      for (const imp of imports) {
        if (!SYSTEM_FRAMEWORKS.has(imp.module)) {
          graph.addEdge(shortPath, `[${imp.module}]`);
        }
      }
    }
  } else {
    // Module-level analysis from imports
    const fileModuleMap = inferModuleFromPath(swiftFiles, projectPath);
    for (const [filePath, imports] of importMap) {
      const sourceModule = fileModuleMap.get(filePath) ?? "Unknown";
      graph.addNode(sourceModule);
      for (const imp of imports) {
        if (!SYSTEM_FRAMEWORKS.has(imp.module) && sourceModule !== imp.module) {
          graph.addEdge(sourceModule, imp.module);
        }
      }
    }
  }

  // Find cycles
  const cycleResult = graph.findCycles();
  const lines: string[] = [];

  lines.push(`## Circular Dependency Analysis (${level} level)`);
  lines.push(`- **Modules analyzed:** ${graph.getNodes().length}`);
  lines.push(`- **${cycleResult.summary}**\n`);

  if (!cycleResult.hasCycles) {
    lines.push("No circular dependencies found. The dependency graph is clean.");

    // Show topological order
    const sorted = graph.topologicalSort();
    if (sorted && sorted.length > 0) {
      lines.push("\n### Build Order (topological sort)");
      sorted.forEach((node, i) => {
        lines.push(`${i + 1}. ${node}`);
      });
    }
  } else {
    lines.push("### Circular Dependency Groups\n");
    cycleResult.cycles.forEach((cycle, i) => {
      lines.push(`**Group ${i + 1}** (${cycle.length} modules):`);
      // Show cycle path
      const cyclePath = [...cycle, cycle[0]].join(" → ");
      lines.push(`\`${cyclePath}\`\n`);

      // Show which edges create the cycle
      lines.push("Edges in this cycle:");
      for (let j = 0; j < cycle.length; j++) {
        const from = cycle[j];
        const to = cycle[(j + 1) % cycle.length];
        if (graph.getNeighbors(from).has(to)) {
          lines.push(`  - ${from} → ${to}`);
        }
      }
      lines.push("");
    });

    // Suggest fixes
    lines.push("### Suggested Fixes");
    lines.push("- Extract shared types/protocols into a separate module");
    lines.push("- Use dependency inversion (protocol in shared module, implementation in feature module)");
    lines.push("- Consider if any dependency can be replaced with a delegate/callback pattern");

    // Show Mermaid diagram
    lines.push("\n### Dependency Graph");
    lines.push("```mermaid");
    lines.push(graph.toMermaid());
    lines.push("```");
  }

  return lines.join("\n");
}

function inferModuleFromPath(
  filePaths: string[],
  projectPath: string,
): Map<string, string> {
  const map = new Map<string, string>();

  for (const filePath of filePaths) {
    const relative = filePath.replace(projectPath + "/", "");
    const parts = relative.split("/");

    const srcIdx = parts.findIndex(
      (p) => p === "Sources" || p === "Source",
    );
    if (srcIdx !== -1 && parts.length > srcIdx + 1) {
      map.set(filePath, parts[srcIdx + 1]);
      continue;
    }

    const modIdx = parts.findIndex(
      (p) => p === "Modules" || p === "Features",
    );
    if (modIdx !== -1 && parts.length > modIdx + 1) {
      map.set(filePath, parts[modIdx + 1]);
      continue;
    }

    if (parts.length >= 2) {
      map.set(filePath, parts[0]);
    } else {
      map.set(filePath, "Root");
    }
  }

  return map;
}

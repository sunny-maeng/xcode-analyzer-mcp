import { scanSwiftFiles } from "../utils/file-scanner.js";
import { parseImportsFromFiles } from "../parsers/swift-import-parser.js";
import { parsePackageSwift } from "../parsers/package-swift-parser.js";
import { parseTypesFromFile, type TypeDeclaration } from "../parsers/swift-type-parser.js";
import { DirectedGraph } from "../graph/directed-graph.js";
import { detectProject } from "../utils/project-detector.js";
import { formatTable } from "../utils/formatter.js";

export interface CircularDependencyOptions {
  projectPath: string;
  level?: "module" | "file" | "type";
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

  if (level === "type") {
    return analyzeTypeLevel(projectPath, excludePatterns);
  }

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
    // File-level: build graph based on type references across files
    return analyzeFileLevel(projectPath, swiftFiles, excludePatterns);
  }

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

  return formatCycleResult(graph, level);
}

/**
 * Type-level circular dependency analysis.
 * Finds: class A → class B → class A (via properties, inheritance, etc.)
 * Also detects potential retain cycles (strong reference cycles in classes).
 */
async function analyzeTypeLevel(
  projectPath: string,
  excludePatterns: string[],
): Promise<string> {
  const swiftFiles = await scanSwiftFiles(projectPath, excludePatterns);
  const allTypes: TypeDeclaration[] = [];

  // Parse all Swift files for type declarations
  const batchSize = 50;
  for (let i = 0; i < swiftFiles.length; i += batchSize) {
    const batch = swiftFiles.slice(i, i + batchSize);
    const results = await Promise.all(
      batch.map(async (fp) => {
        try {
          return await parseTypesFromFile(fp);
        } catch {
          return [];
        }
      }),
    );
    allTypes.push(...results.flat());
  }

  // Build type name → declaration map
  const typeMap = new Map<string, TypeDeclaration>();
  for (const t of allTypes) {
    typeMap.set(t.name, t);
  }

  // Build type dependency graph
  const graph = new DirectedGraph();
  for (const t of allTypes) {
    graph.addNode(t.name);
    for (const ref of t.referencedTypes) {
      // Only add edges to types defined in this project
      if (typeMap.has(ref) && ref !== t.name) {
        graph.addEdge(t.name, ref);
      }
    }
  }

  const cycleResult = graph.findCycles();
  const lines: string[] = [];

  lines.push("## Circular Dependency Analysis (type level)");
  lines.push(`- **Types analyzed:** ${allTypes.length}`);
  lines.push(`- **${cycleResult.summary}**\n`);

  if (!cycleResult.hasCycles) {
    lines.push("No circular type references detected.");
  } else {
    lines.push("### Circular Type Reference Groups\n");
    cycleResult.cycles.forEach((cycle, i) => {
      lines.push(`**Group ${i + 1}** (${cycle.length} types):`);
      const cyclePath = [...cycle, cycle[0]].join(" → ");
      lines.push(`\`${cyclePath}\`\n`);

      // Show details for each type in the cycle
      for (const typeName of cycle) {
        const decl = typeMap.get(typeName);
        if (decl) {
          const shortPath = decl.filePath.replace(projectPath + "/", "");
          lines.push(`  - **${typeName}** (${decl.kind}) — ${shortPath}:${decl.line}`);

          // Show which properties reference other types in the cycle
          for (const prop of decl.properties) {
            const refsInCycle = cycle.filter(
              (c) => c !== typeName && prop.typeName.includes(c),
            );
            if (refsInCycle.length > 0) {
              const weakLabel = prop.isWeak ? " (weak)" : " ⚠️ STRONG";
              lines.push(`    - \`${prop.name}: ${prop.typeName}\`${weakLabel}`);
            }
          }
        }
      }
      lines.push("");
    });

    // Detect potential retain cycles (class-only, strong references)
    const retainCycles = detectRetainCycles(cycleResult.cycles, typeMap);
    if (retainCycles.length > 0) {
      lines.push("### ⚠️ Potential Retain Cycles\n");
      lines.push("These cycles involve classes with strong references — likely memory leaks:\n");
      for (const rc of retainCycles) {
        lines.push(`- ${rc.path}`);
        lines.push(`  **Fix:** Make one of these properties \`weak\` or \`unowned\``);
        for (const prop of rc.strongProps) {
          lines.push(`  - \`${prop.ownerType}.${prop.name}: ${prop.typeName}\` → add \`weak\``);
        }
        lines.push("");
      }
    }

    // Suggest fixes
    lines.push("### Suggested Fixes");
    lines.push("- Use `weak` or `unowned` references to break retain cycles");
    lines.push("- Extract a shared protocol that both types conform to");
    lines.push("- Use a delegate pattern with a weak reference");
    lines.push("- Consider using a mediator/coordinator to decouple types");

    // Mermaid diagram
    if (allTypes.length <= 100) {
      lines.push("\n### Type Dependency Graph");
      lines.push("```mermaid");
      lines.push(graph.toMermaid());
      lines.push("```");
    }
  }

  return lines.join("\n");
}

/**
 * File-level circular dependency analysis.
 * Checks if file A references types defined in file B and vice versa.
 */
async function analyzeFileLevel(
  projectPath: string,
  swiftFiles: string[],
  excludePatterns: string[],
): Promise<string> {
  const allTypes: TypeDeclaration[] = [];

  const batchSize = 50;
  for (let i = 0; i < swiftFiles.length; i += batchSize) {
    const batch = swiftFiles.slice(i, i + batchSize);
    const results = await Promise.all(
      batch.map(async (fp) => {
        try {
          return await parseTypesFromFile(fp);
        } catch {
          return [];
        }
      }),
    );
    allTypes.push(...results.flat());
  }

  // Map: type name → file path
  const typeToFile = new Map<string, string>();
  for (const t of allTypes) {
    typeToFile.set(t.name, t.filePath);
  }

  // Build file-to-file dependency graph
  const graph = new DirectedGraph();
  for (const t of allTypes) {
    const sourceFile = t.filePath.replace(projectPath + "/", "");
    graph.addNode(sourceFile);

    for (const ref of t.referencedTypes) {
      const targetFilePath = typeToFile.get(ref);
      if (targetFilePath && targetFilePath !== t.filePath) {
        const targetFile = targetFilePath.replace(projectPath + "/", "");
        graph.addEdge(sourceFile, targetFile);
      }
    }
  }

  return formatCycleResult(graph, "file");
}

interface RetainCycleInfo {
  path: string;
  strongProps: { ownerType: string; name: string; typeName: string }[];
}

function detectRetainCycles(
  cycles: string[][],
  typeMap: Map<string, TypeDeclaration>,
): RetainCycleInfo[] {
  const retainCycles: RetainCycleInfo[] = [];

  for (const cycle of cycles) {
    // Check if ALL types in cycle are classes (only classes have retain cycles)
    const allClasses = cycle.every((name) => {
      const decl = typeMap.get(name);
      return decl?.kind === "class" || decl?.kind === "actor";
    });

    if (!allClasses) continue;

    // Find strong (non-weak) properties that create the cycle
    const strongProps: RetainCycleInfo["strongProps"] = [];
    for (let j = 0; j < cycle.length; j++) {
      const fromType = typeMap.get(cycle[j]);
      const toTypeName = cycle[(j + 1) % cycle.length];
      if (!fromType) continue;

      for (const prop of fromType.properties) {
        if (!prop.isWeak && prop.typeName.includes(toTypeName)) {
          strongProps.push({
            ownerType: cycle[j],
            name: prop.name,
            typeName: prop.typeName,
          });
        }
      }
    }

    if (strongProps.length > 0) {
      retainCycles.push({
        path: [...cycle, cycle[0]].join(" → "),
        strongProps,
      });
    }
  }

  return retainCycles;
}

function formatCycleResult(graph: DirectedGraph, level: string): string {
  const cycleResult = graph.findCycles();
  const lines: string[] = [];

  lines.push(`## Circular Dependency Analysis (${level} level)`);
  lines.push(`- **Nodes analyzed:** ${graph.getNodes().length}`);
  lines.push(`- **${cycleResult.summary}**\n`);

  if (!cycleResult.hasCycles) {
    lines.push("No circular dependencies found. The dependency graph is clean.");

    const sorted = graph.topologicalSort();
    if (sorted && sorted.length > 0 && sorted.length <= 50) {
      lines.push("\n### Build Order (topological sort)");
      sorted.forEach((node, i) => {
        lines.push(`${i + 1}. ${node}`);
      });
    }
  } else {
    lines.push("### Circular Dependency Groups\n");
    cycleResult.cycles.forEach((cycle, i) => {
      lines.push(`**Group ${i + 1}** (${cycle.length} nodes):`);
      const cyclePath = [...cycle, cycle[0]].join(" → ");
      lines.push(`\`${cyclePath}\`\n`);

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

    lines.push("### Suggested Fixes");
    lines.push("- Extract shared types/protocols into a separate module");
    lines.push("- Use dependency inversion (protocol in shared module, implementation in feature module)");
    lines.push("- Consider if any dependency can be replaced with a delegate/callback pattern");

    if (graph.getNodes().length <= 100) {
      lines.push("\n### Dependency Graph");
      lines.push("```mermaid");
      lines.push(graph.toMermaid());
      lines.push("```");
    }
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

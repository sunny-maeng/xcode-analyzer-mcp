import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { analyzeCircularDependencies } from "./analyzers/circular-dependency.js";
import { analyzeBuildTime } from "./analyzers/build-time.js";
import { analyzeImportGraph } from "./analyzers/import-graph.js";
import { detectUnusedImports } from "./analyzers/unused-imports.js";
import { analyzeDependencyTree } from "./analyzers/dependency-tree.js";
import { analyzeLargeFiles } from "./analyzers/large-files.js";

export function createServer(): McpServer {
  const server = new McpServer({
    name: "xcode-analyzer",
    version: "1.0.0",
  });

  // Tool 1: Circular Dependencies
  server.tool(
    "analyze_circular_dependencies",
    "Detect circular dependencies between modules/files in an Xcode project using Tarjan's SCC algorithm. Analyzes Package.swift targets and Swift import statements.",
    {
      projectPath: z.string().describe("Path to the Xcode project root directory"),
      level: z
        .enum(["module", "file", "type"])
        .optional()
        .describe("Analysis level: 'module' for module-level, 'file' for file-level, 'type' for class/struct circular references and retain cycles (default: module)"),
      excludePatterns: z
        .array(z.string())
        .optional()
        .describe("Glob patterns to exclude (e.g., ['**/Tests/**'])"),
    },
    async ({ projectPath, level, excludePatterns }) => {
      try {
        const result = await analyzeCircularDependencies({
          projectPath,
          level: level ?? "module",
          excludePatterns: excludePatterns ?? [],
        });
        return { content: [{ type: "text", text: result }] };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );

  // Tool 2: Build Time Analysis
  server.tool(
    "analyze_build_time",
    "Analyze Xcode build times from DerivedData build logs. Shows slowest files and modules. Falls back to static complexity analysis if no build logs are found.",
    {
      projectPath: z.string().describe("Path to the Xcode project root directory"),
      derivedDataPath: z
        .string()
        .optional()
        .describe("Custom DerivedData path (default: ~/Library/Developer/Xcode/DerivedData)"),
      scheme: z
        .string()
        .optional()
        .describe("Xcode scheme name to match in DerivedData"),
      topN: z
        .number()
        .min(1)
        .max(100)
        .optional()
        .describe("Number of top slow files to show (default: 20)"),
      thresholdMs: z
        .number()
        .optional()
        .describe("Only show files taking longer than this (ms, default: 0)"),
    },
    async ({ projectPath, derivedDataPath, scheme, topN, thresholdMs }) => {
      try {
        const result = await analyzeBuildTime({
          projectPath,
          derivedDataPath,
          scheme,
          topN: topN ?? 20,
          thresholdMs: thresholdMs ?? 0,
        });
        return { content: [{ type: "text", text: result }] };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );

  // Tool 3: Import Dependency Graph
  server.tool(
    "analyze_import_graph",
    "Build a module dependency graph from Swift import statements. Shows fan-in/fan-out statistics and can output as adjacency list, matrix, Mermaid diagram, or DOT/Graphviz format.",
    {
      projectPath: z.string().describe("Path to the Xcode project root directory"),
      outputFormat: z
        .enum(["adjacency_list", "matrix", "mermaid", "dot"])
        .optional()
        .describe("Output format (default: adjacency_list)"),
      includeSystemFrameworks: z
        .boolean()
        .optional()
        .describe("Include system frameworks like UIKit, Foundation (default: false)"),
      excludePatterns: z
        .array(z.string())
        .optional()
        .describe("Glob patterns to exclude"),
    },
    async ({ projectPath, outputFormat, includeSystemFrameworks, excludePatterns }) => {
      try {
        const result = await analyzeImportGraph({
          projectPath,
          outputFormat: outputFormat ?? "adjacency_list",
          includeSystemFrameworks: includeSystemFrameworks ?? false,
          excludePatterns: excludePatterns ?? [],
        });
        return { content: [{ type: "text", text: result }] };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );

  // Tool 4: Unused Imports Detection
  server.tool(
    "detect_unused_imports",
    "Detect potentially unused Swift import statements using heuristic analysis. Checks against a built-in symbol database for popular iOS frameworks (UIKit, RxSwift, SnapKit, etc.).",
    {
      projectPath: z.string().describe("Path to the Xcode project root directory"),
      targetPaths: z
        .array(z.string())
        .optional()
        .describe("Specific files/directories to analyze (default: entire project)"),
      confidence: z
        .enum(["high", "medium", "low"])
        .optional()
        .describe("Confidence filter: high=certain only, medium=likely, low=all suspects (default: medium)"),
      excludePatterns: z
        .array(z.string())
        .optional()
        .describe("Glob patterns to exclude"),
    },
    async ({ projectPath, targetPaths, confidence, excludePatterns }) => {
      try {
        const result = await detectUnusedImports({
          projectPath,
          targetPaths: targetPaths ?? undefined,
          confidence: confidence ?? "medium",
          excludePatterns: excludePatterns ?? [],
        });
        return { content: [{ type: "text", text: result }] };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );

  // Tool 5: Dependency Tree
  server.tool(
    "analyze_dependency_tree",
    "Analyze SPM (Package.resolved) and CocoaPods (Podfile.lock) dependency trees. Shows direct and transitive dependencies, version info, and tree structure.",
    {
      projectPath: z.string().describe("Path to the Xcode project root directory"),
      packageManager: z
        .enum(["spm", "cocoapods", "auto"])
        .optional()
        .describe("Package manager to analyze (default: auto-detect)"),
      showTransitive: z
        .boolean()
        .optional()
        .describe("Show transitive dependency tree (default: true)"),
    },
    async ({ projectPath, packageManager, showTransitive }) => {
      try {
        const result = await analyzeDependencyTree({
          projectPath,
          packageManager: packageManager ?? "auto",
          showTransitive: showTransitive ?? true,
        });
        return { content: [{ type: "text", text: result }] };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );

  // Tool 6: Large Files Detection
  server.tool(
    "detect_large_files",
    "Find large files and resources in the project that impact app size. Scans images, videos, fonts, JSON, xcassets, and other file types.",
    {
      projectPath: z.string().describe("Path to the Xcode project root directory"),
      thresholdKB: z
        .number()
        .min(1)
        .optional()
        .describe("Minimum file size in KB to report (default: 500)"),
      categories: z
        .array(z.enum(["images", "videos", "fonts", "json", "plists", "xcassets", "storyboards", "all"]))
        .optional()
        .describe("File categories to scan (default: ['all'])"),
      checkXcassets: z
        .boolean()
        .optional()
        .describe("Analyze .xcassets image sets individually (default: true)"),
    },
    async ({ projectPath, thresholdKB, categories, checkXcassets }) => {
      try {
        const result = await analyzeLargeFiles({
          projectPath,
          thresholdKB: thresholdKB ?? 500,
          categories: categories ?? ["all"],
          checkXcassets: checkXcassets ?? true,
        });
        return { content: [{ type: "text", text: result }] };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );

  return server;
}

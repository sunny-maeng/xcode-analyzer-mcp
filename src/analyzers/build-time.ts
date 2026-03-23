import { findBuildLog, parseBuildLog } from "../parsers/build-log-parser.js";
import { scanSwiftFiles } from "../utils/file-scanner.js";
import { readFile, stat } from "node:fs/promises";
import { join, basename } from "node:path";
import { formatMs, formatTable } from "../utils/formatter.js";
import type { BuildTimeEntry } from "../types/analysis.js";

export interface BuildTimeOptions {
  projectPath: string;
  derivedDataPath?: string;
  scheme?: string;
  topN?: number;
  thresholdMs?: number;
}

export async function analyzeBuildTime(options: BuildTimeOptions): Promise<string> {
  const {
    projectPath,
    derivedDataPath,
    scheme,
    topN = 20,
    thresholdMs = 0,
  } = options;

  const lines: string[] = [];
  lines.push("## Build Time Analysis\n");

  // Try to find and parse actual build logs
  const ddPath = derivedDataPath ?? join(
    process.env.HOME ?? "~",
    "Library/Developer/Xcode/DerivedData",
  );

  const logPath = await findBuildLog(ddPath, scheme);

  if (logPath) {
    lines.push(`**Source:** ${logPath}\n`);

    try {
      const entries = await parseBuildLog(logPath);
      const filtered = entries.filter((e) => e.durationMs >= thresholdMs);
      const top = filtered.slice(0, topN);

      if (top.length > 0 && top.some((e) => e.durationMs > 0)) {
        lines.push(`### Slowest Files (top ${topN})\n`);
        const rows = top.map((e) => [
          e.filePath.split("/").pop() ?? e.filePath,
          formatMs(e.durationMs),
          e.filePath,
        ]);
        lines.push(formatTable(["File", "Duration", "Path"], rows));

        const totalMs = entries.reduce((sum, e) => sum + e.durationMs, 0);
        lines.push(`\n**Total compilation time:** ${formatMs(totalMs)}`);
        lines.push(`**Files compiled:** ${entries.length}`);
      } else {
        lines.push("Build log found but no timing data could be extracted.");
        lines.push("Falling back to static complexity analysis...\n");
        return lines.join("\n") + "\n" + await staticComplexityAnalysis(projectPath, topN);
      }
    } catch (err) {
      lines.push(`Failed to parse build log: ${err instanceof Error ? err.message : String(err)}`);
      lines.push("Falling back to static complexity analysis...\n");
      return lines.join("\n") + "\n" + await staticComplexityAnalysis(projectPath, topN);
    }
  } else {
    lines.push("No Xcode build logs found in DerivedData.");
    lines.push("Showing static complexity analysis instead (estimated build impact).\n");
    lines.push(await staticComplexityAnalysis(projectPath, topN));
  }

  return lines.join("\n");
}

/**
 * Static heuristic analysis of build complexity.
 * Estimates which files are likely slow to compile based on:
 * - File size (LOC)
 * - Generic usage
 * - Protocol conformance complexity
 * - Type inference chains
 */
async function staticComplexityAnalysis(
  projectPath: string,
  topN: number,
): Promise<string> {
  const swiftFiles = await scanSwiftFiles(projectPath);
  const scored: { file: string; score: number; loc: number; reasons: string[] }[] = [];

  const batchSize = 50;
  for (let i = 0; i < swiftFiles.length; i += batchSize) {
    const batch = swiftFiles.slice(i, i + batchSize);
    const results = await Promise.all(
      batch.map(async (filePath) => {
        try {
          const source = await readFile(filePath, "utf-8");
          return analyzeFileComplexity(filePath, source, projectPath);
        } catch {
          return null;
        }
      }),
    );
    scored.push(...results.filter(Boolean) as typeof scored);
  }

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, topN);

  const lines: string[] = [];
  lines.push("### Static Complexity Score (estimated build impact)\n");
  lines.push("*Higher score = likely slower to compile*\n");

  const rows = top.map((f) => [
    f.file.replace(projectPath + "/", ""),
    String(f.score),
    String(f.loc),
    f.reasons.join(", "),
  ]);
  lines.push(formatTable(["File", "Score", "LOC", "Complexity Factors"], rows));

  return lines.join("\n");
}

function analyzeFileComplexity(
  filePath: string,
  source: string,
  projectPath: string,
): { file: string; score: number; loc: number; reasons: string[] } {
  const lines = source.split("\n");
  const loc = lines.filter((l) => l.trim().length > 0 && !l.trim().startsWith("//")).length;
  let score = 0;
  const reasons: string[] = [];

  // File size contributes to compile time
  if (loc > 500) {
    score += Math.floor(loc / 100);
    reasons.push(`large (${loc} LOC)`);
  }

  // Generic functions/types (type checker intensive)
  const genericCount = (source.match(/<[A-Z]\w*(?:\s*:\s*\w+)?(?:\s*,\s*[A-Z]\w*(?:\s*:\s*\w+)?)*>/g) ?? []).length;
  if (genericCount > 5) {
    score += genericCount * 2;
    reasons.push(`generics (${genericCount})`);
  }

  // Protocol conformance (type checker intensive)
  const protocolCount = (source.match(/:\s*\w+Protocol|:\s*\w+able|:\s*\w+ing\b/g) ?? []).length;
  if (protocolCount > 3) {
    score += protocolCount * 2;
    reasons.push(`protocols (${protocolCount})`);
  }

  // Complex closures (type inference)
  const closureCount = (source.match(/\{\s*(?:\[weak self\]|\[unowned self\])?\s*(?:\w+(?:\s*,\s*\w+)*)?\s*in\b/g) ?? []).length;
  if (closureCount > 10) {
    score += closureCount;
    reasons.push(`closures (${closureCount})`);
  }

  // Long type inference chains (.map {}.filter {}.compactMap {})
  const chainCount = (source.match(/\.\w+\s*\{[^}]*\}\s*\.\w+/g) ?? []).length;
  if (chainCount > 5) {
    score += chainCount * 2;
    reasons.push(`chains (${chainCount})`);
  }

  // String interpolation complexity
  const interpolationCount = (source.match(/\\(\([^)]*\))/g) ?? []).length;
  if (interpolationCount > 20) {
    score += Math.floor(interpolationCount / 5);
    reasons.push(`interpolations (${interpolationCount})`);
  }

  if (reasons.length === 0) reasons.push("normal");

  return { file: filePath, score, loc, reasons };
}

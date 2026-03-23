import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { createGunzip } from "node:zlib";
import { createReadStream } from "node:fs";
import type { BuildTimeEntry } from "../types/analysis.js";

/**
 * Find the most recent xcactivitylog for a project in DerivedData.
 */
export async function findBuildLog(
  derivedDataPath: string,
  projectName?: string,
): Promise<string | null> {
  const defaultPath =
    derivedDataPath ??
    join(
      process.env.HOME ?? "~",
      "Library/Developer/Xcode/DerivedData",
    );

  try {
    const entries = await readdir(defaultPath);
    const matching = entries
      .filter((e) => !projectName || e.toLowerCase().startsWith(projectName.toLowerCase()))
      .sort()
      .reverse();

    for (const dir of matching) {
      const logsPath = join(defaultPath, dir, "Logs/Build");
      try {
        const logs = await readdir(logsPath);
        const actLogs = logs
          .filter((f) => f.endsWith(".xcactivitylog"))
          .sort()
          .reverse();
        if (actLogs.length > 0) {
          return join(logsPath, actLogs[0]);
        }
      } catch {
        continue;
      }
    }
  } catch {
    return null;
  }

  return null;
}

/**
 * Read and decompress xcactivitylog (gzip compressed).
 */
async function readActivityLog(logPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const gunzip = createGunzip();
    const stream = createReadStream(logPath);

    stream.pipe(gunzip);
    gunzip.on("data", (chunk: Buffer) => chunks.push(chunk));
    gunzip.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    gunzip.on("error", reject);
    stream.on("error", reject);
  });
}

/**
 * Parse build timing data from xcactivitylog content.
 * Extracts CompileSwift entries with file paths and durations.
 */
export function parseBuildTimings(logContent: string): BuildTimeEntry[] {
  const entries: BuildTimeEntry[] = [];

  // Pattern: CompileSwift normal ... /path/to/file.swift (duration)
  // The SLF format is complex, so we use heuristic text matching
  const lines = logContent.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Look for CompileSwift or CompileSwiftSources
    if (!line.includes("CompileSwift") && !line.includes("SwiftCompile")) continue;

    // Extract file path
    const pathMatch = line.match(/\/[^\s]+\.swift/);
    if (!pathMatch) continue;

    // Look for duration in nearby lines or same line
    // Duration format varies: "0.123 seconds" or "123ms"
    const durationMatch = line.match(/(\d+\.?\d*)\s*(?:seconds?|ms)/i);
    let durationMs = 0;

    if (durationMatch) {
      const value = parseFloat(durationMatch[1]);
      durationMs = durationMatch[0].toLowerCase().includes("ms") ? value : value * 1000;
    } else {
      // Try next few lines for duration
      for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
        const dm = lines[j].match(/(\d+\.?\d*)\s*(?:seconds?|ms)/i);
        if (dm) {
          const v = parseFloat(dm[1]);
          durationMs = dm[0].toLowerCase().includes("ms") ? v : v * 1000;
          break;
        }
      }
    }

    if (pathMatch[0]) {
      entries.push({
        filePath: pathMatch[0],
        durationMs,
      });
    }
  }

  // Deduplicate by file path, keeping the longest duration
  const deduped = new Map<string, BuildTimeEntry>();
  for (const entry of entries) {
    const existing = deduped.get(entry.filePath);
    if (!existing || existing.durationMs < entry.durationMs) {
      deduped.set(entry.filePath, entry);
    }
  }

  return [...deduped.values()].sort((a, b) => b.durationMs - a.durationMs);
}

/**
 * Parse build log from xcactivitylog file.
 */
export async function parseBuildLog(logPath: string): Promise<BuildTimeEntry[]> {
  const content = await readActivityLog(logPath);
  return parseBuildTimings(content);
}

import fg from "fast-glob";
import { stat } from "node:fs/promises";
import { join } from "node:path";

export interface ScanOptions {
  patterns: string[];
  cwd: string;
  ignore?: string[];
}

export async function scanFiles(options: ScanOptions): Promise<string[]> {
  const defaultIgnore = [
    "**/node_modules/**",
    "**/DerivedData/**",
    "**/.build/**",
    "**/Pods/**",
    "**/.git/**",
  ];

  const files = await fg(options.patterns, {
    cwd: options.cwd,
    ignore: [...defaultIgnore, ...(options.ignore ?? [])],
    absolute: true,
    dot: false,
  });

  return files.sort();
}

export async function scanSwiftFiles(
  projectPath: string,
  ignore?: string[],
): Promise<string[]> {
  return scanFiles({
    patterns: ["**/*.swift"],
    cwd: projectPath,
    ignore,
  });
}

export interface FileWithSize {
  path: string;
  relativePath: string;
  sizeBytes: number;
}

export async function scanFilesWithSize(
  projectPath: string,
  patterns: string[],
  ignore?: string[],
): Promise<FileWithSize[]> {
  const files = await scanFiles({ patterns, cwd: projectPath, ignore });

  const results: FileWithSize[] = [];
  const batchSize = 100;

  for (let i = 0; i < files.length; i += batchSize) {
    const batch = files.slice(i, i + batchSize);
    const stats = await Promise.all(
      batch.map(async (filePath) => {
        try {
          const s = await stat(filePath);
          return {
            path: filePath,
            relativePath: filePath.replace(projectPath + "/", ""),
            sizeBytes: s.size,
          };
        } catch {
          return null;
        }
      }),
    );
    results.push(...(stats.filter(Boolean) as FileWithSize[]));
  }

  return results.sort((a, b) => b.sizeBytes - a.sizeBytes);
}

import { readFile } from "node:fs/promises";
import type { ImportInfo } from "../types/analysis.js";

const IMPORT_REGEX = /^\s*(?:@testable\s+)?import\s+(?:struct|class|enum|protocol|typealias|func|var|let)?\s*(\w+)(?:\.(\w+))?/;

/**
 * Parse import statements from a Swift file.
 * Handles: import Module, @testable import Module, import struct Module.Type
 * Skips: comments and string literals
 */
export function parseImportsFromSource(source: string, filePath: string): ImportInfo[] {
  const imports: ImportInfo[] = [];
  const lines = source.split("\n");

  let inBlockComment = false;

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    // Handle block comments
    if (inBlockComment) {
      const endIdx = line.indexOf("*/");
      if (endIdx !== -1) {
        inBlockComment = false;
        line = line.substring(endIdx + 2);
      } else {
        continue;
      }
    }

    // Remove block comment starts
    const blockStart = line.indexOf("/*");
    if (blockStart !== -1) {
      const blockEnd = line.indexOf("*/", blockStart + 2);
      if (blockEnd !== -1) {
        line = line.substring(0, blockStart) + line.substring(blockEnd + 2);
      } else {
        inBlockComment = true;
        line = line.substring(0, blockStart);
      }
    }

    // Remove line comments
    const commentIdx = line.indexOf("//");
    if (commentIdx !== -1) {
      line = line.substring(0, commentIdx);
    }

    const match = line.match(IMPORT_REGEX);
    if (match) {
      const isTestable = line.includes("@testable");
      imports.push({
        module: match[1],
        isTestable,
        subSymbol: match[2] || undefined,
        filePath,
        line: i + 1,
      });
    }
  }

  return imports;
}

export async function parseImportsFromFile(filePath: string): Promise<ImportInfo[]> {
  const source = await readFile(filePath, "utf-8");
  return parseImportsFromSource(source, filePath);
}

/**
 * Parse imports from multiple Swift files and group by file.
 */
export async function parseImportsFromFiles(
  filePaths: string[],
): Promise<Map<string, ImportInfo[]>> {
  const result = new Map<string, ImportInfo[]>();
  const batchSize = 100;

  for (let i = 0; i < filePaths.length; i += batchSize) {
    const batch = filePaths.slice(i, i + batchSize);
    const parsed = await Promise.all(
      batch.map(async (fp) => {
        try {
          const imports = await parseImportsFromFile(fp);
          return { filePath: fp, imports };
        } catch {
          return { filePath: fp, imports: [] };
        }
      }),
    );
    for (const { filePath, imports } of parsed) {
      if (imports.length > 0) {
        result.set(filePath, imports);
      }
    }
  }

  return result;
}

/**
 * Extract unique module names from import map.
 */
export function getUniqueModules(importMap: Map<string, ImportInfo[]>): string[] {
  const modules = new Set<string>();
  for (const imports of importMap.values()) {
    for (const imp of imports) {
      modules.add(imp.module);
    }
  }
  return [...modules].sort();
}

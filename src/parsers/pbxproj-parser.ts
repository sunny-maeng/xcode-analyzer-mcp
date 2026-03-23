import { readFile } from "node:fs/promises";
import type { PbxprojData, PbxTarget } from "../types/xcode.js";

/**
 * Lightweight .pbxproj parser.
 * Only extracts sections needed for dependency analysis:
 * - PBXNativeTarget (targets + dependencies)
 * - PBXFrameworksBuildPhase (linked frameworks)
 * - PBXFileReference (file paths)
 */
export async function parsePbxproj(filePath: string): Promise<PbxprojData> {
  const source = await readFile(filePath, "utf-8");
  return parsePbxprojSource(source);
}

export function parsePbxprojSource(source: string): PbxprojData {
  const targets = parseNativeTargets(source);
  const fileReferences = parseFileReferences(source);
  const frameworkPhases = parseFrameworkBuildPhases(source);

  // Link framework dependencies to targets
  for (const [, target] of targets) {
    const frameworkFiles = frameworkPhases.get(target.id) ?? [];
    target.frameworkDependencies = frameworkFiles
      .map((ref) => {
        const path = fileReferences.get(ref);
        if (!path) return null;
        // Extract framework name from path
        const match = path.match(/([^/]+)\.framework$/);
        return match ? match[1] : null;
      })
      .filter(Boolean) as string[];
  }

  return { targets, fileReferences, groups: new Map() };
}

function parseNativeTargets(source: string): Map<string, PbxTarget> {
  const targets = new Map<string, PbxTarget>();

  // Find PBXNativeTarget section
  const section = extractSection(source, "PBXNativeTarget");
  if (!section) return targets;

  // Parse each target entry
  const entryRegex = /([A-F0-9]{24})\s*\/\*\s*(.+?)\s*\*\/\s*=\s*\{([^}]*(?:\{[^}]*\}[^}]*)*)\}/g;
  let match: RegExpExecArray | null;

  while ((match = entryRegex.exec(section)) !== null) {
    const id = match[1];
    const name = match[2];
    const body = match[3];

    const productNameMatch = body.match(/productName\s*=\s*"?([^";]+)"?\s*;/);
    const depIdsMatch = body.match(/dependencies\s*=\s*\(([\s\S]*?)\)/);
    const buildPhaseIdsMatch = body.match(/buildPhases\s*=\s*\(([\s\S]*?)\)/);

    const dependencies = depIdsMatch
      ? [...depIdsMatch[1].matchAll(/([A-F0-9]{24})/g)].map((m) => m[1])
      : [];

    targets.set(name, {
      id,
      name,
      productName: productNameMatch?.[1],
      dependencies,
      frameworkDependencies: [],
      sourceFiles: [],
    });
  }

  return targets;
}

function parseFileReferences(source: string): Map<string, string> {
  const refs = new Map<string, string>();

  const section = extractSection(source, "PBXFileReference");
  if (!section) return refs;

  const refRegex = /([A-F0-9]{24})\s*\/\*.*?\*\/\s*=\s*\{[^}]*path\s*=\s*"?([^";]+)"?\s*;/g;
  let match: RegExpExecArray | null;

  while ((match = refRegex.exec(section)) !== null) {
    refs.set(match[1], match[2]);
  }

  return refs;
}

function parseFrameworkBuildPhases(source: string): Map<string, string[]> {
  const phases = new Map<string, string[]>();

  const section = extractSection(source, "PBXFrameworksBuildPhase");
  if (!section) return phases;

  const phaseRegex = /([A-F0-9]{24})\s*\/\*.*?\*\/\s*=\s*\{[^}]*files\s*=\s*\(([\s\S]*?)\)/g;
  let match: RegExpExecArray | null;

  while ((match = phaseRegex.exec(section)) !== null) {
    const id = match[1];
    const fileIds = [...match[2].matchAll(/([A-F0-9]{24})/g)].map((m) => m[1]);
    phases.set(id, fileIds);
  }

  return phases;
}

function extractSection(source: string, sectionName: string): string | null {
  const start = source.indexOf(`/* Begin ${sectionName} section */`);
  const end = source.indexOf(`/* End ${sectionName} section */`);
  if (start === -1 || end === -1) return null;
  return source.substring(start, end);
}

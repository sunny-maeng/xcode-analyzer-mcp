import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import type { WorkspaceProject } from "../types/xcode.js";

/**
 * Parse .xcworkspace/contents.xcworkspacedata XML.
 * Extracts project references (FileRef with location attribute).
 */
export async function parseWorkspace(workspacePath: string): Promise<WorkspaceProject[]> {
  const dataPath = join(workspacePath, "contents.xcworkspacedata");
  const source = await readFile(dataPath, "utf-8");
  return parseWorkspaceSource(source, dirname(workspacePath));
}

export function parseWorkspaceSource(
  source: string,
  basePath: string,
): WorkspaceProject[] {
  const projects: WorkspaceProject[] = [];

  // Match <FileRef location="group:relative/path.xcodeproj"></FileRef>
  const refRegex = /FileRef\s+location\s*=\s*"([^"]+)"/g;
  let match: RegExpExecArray | null;

  while ((match = refRegex.exec(source)) !== null) {
    const location = match[1];
    // Format: "group:path" or "absolute:path" or "container:path"
    const colonIdx = location.indexOf(":");
    const path = colonIdx !== -1 ? location.substring(colonIdx + 1) : location;

    if (path.endsWith(".xcodeproj") || path === "") continue;

    const fullPath = path.startsWith("/") ? path : join(basePath, path);
    const name = path.split("/").pop()?.replace(".xcodeproj", "") ?? path;

    projects.push({ path: fullPath, name });
  }

  return projects;
}

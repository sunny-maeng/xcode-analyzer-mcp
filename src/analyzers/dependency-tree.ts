import { access } from "node:fs/promises";
import { join } from "node:path";
import fg from "fast-glob";
import { parsePackageResolved } from "../parsers/package-resolved-parser.js";
import { parsePodfileLock, buildPodDependencyTree } from "../parsers/podfile-lock-parser.js";
import { parsePackageSwift } from "../parsers/package-swift-parser.js";
import { formatTree, formatTable } from "../utils/formatter.js";
import type { DependencyNode } from "../types/analysis.js";

export interface DependencyTreeOptions {
  projectPath: string;
  packageManager?: "spm" | "cocoapods" | "auto";
  showTransitive?: boolean;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function analyzeDependencyTree(
  options: DependencyTreeOptions,
): Promise<string> {
  const { projectPath, packageManager = "auto", showTransitive = true } = options;

  const lines: string[] = [];
  lines.push("## Dependency Tree Analysis\n");

  const hasSPM = packageManager === "spm" || packageManager === "auto";
  const hasPods = packageManager === "cocoapods" || packageManager === "auto";

  // Find Package.resolved
  if (hasSPM) {
    const resolvedPaths = await fg(
      ["**/Package.resolved", "**/*.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved"],
      { cwd: projectPath, absolute: true, ignore: ["**/DerivedData/**", "**/.build/**"] },
    );

    if (resolvedPaths.length > 0) {
      lines.push("### Swift Package Manager\n");

      const resolved = await parsePackageResolved(resolvedPaths[0]);
      lines.push(`- **Format version:** ${resolved.version}`);
      lines.push(`- **Total packages:** ${resolved.pins.length}\n`);

      // Table of packages
      const rows = resolved.pins
        .sort((a, b) => a.identity.localeCompare(b.identity))
        .map((pin) => [
          pin.identity,
          pin.version ?? pin.branch ?? pin.revision?.substring(0, 7) ?? "-",
          pin.location,
        ]);

      lines.push(formatTable(["Package", "Version", "Repository"], rows));

      // Check for Package.swift to show target dependencies
      const packageSwiftPaths = await fg(["**/Package.swift"], {
        cwd: projectPath,
        absolute: true,
        ignore: ["**/DerivedData/**", "**/.build/**", "**/checkouts/**"],
        deep: 2,
      });

      if (packageSwiftPaths.length > 0 && showTransitive) {
        try {
          const pkgData = await parsePackageSwift(packageSwiftPaths[0]);
          lines.push("\n#### Target Dependencies");

          for (const target of pkgData.targets) {
            if (target.dependencies.length === 0) continue;
            const deps = target.dependencies.map((d) =>
              d.isProduct ? `${d.name} (from: ${d.package})` : d.name,
            );
            lines.push(`- **${target.name}** (${target.type}): ${deps.join(", ")}`);
          }
        } catch {
          // Package.swift parsing failed
        }
      }
    }
  }

  // Find Podfile.lock
  if (hasPods) {
    const podfileLockPath = join(projectPath, "Podfile.lock");
    const subPaths = await fg(["**/Podfile.lock"], {
      cwd: projectPath,
      absolute: true,
      deep: 2,
      ignore: ["**/Pods/**"],
    });

    const lockPath = (await fileExists(podfileLockPath))
      ? podfileLockPath
      : subPaths[0];

    if (lockPath) {
      lines.push("\n### CocoaPods\n");

      const { pods, directDeps } = await parsePodfileLock(lockPath);
      const transitiveDeps = pods.filter(
        (p) => !directDeps.some((d) => p.name.startsWith(d)),
      );

      lines.push(`- **Direct dependencies:** ${directDeps.length}`);
      lines.push(`- **Total pods (including transitive):** ${pods.length}`);
      lines.push(`- **Transitive-only pods:** ${transitiveDeps.length}\n`);

      if (showTransitive) {
        const tree = buildPodDependencyTree(pods, directDeps);
        lines.push("#### Dependency Tree");
        lines.push("```");
        for (const node of tree) {
          lines.push(formatTree({ name: `${node.name} (${node.version ?? "?"})`, children: formatChildren(node.children) }));
        }
        lines.push("```");
      } else {
        lines.push("#### Direct Dependencies");
        const rows = directDeps.map((name) => {
          const pod = pods.find((p) => p.name === name);
          return [name, pod?.version ?? "-", String(pod?.dependencies.length ?? 0)];
        });
        lines.push(formatTable(["Pod", "Version", "Sub-deps"], rows));
      }
    }
  }

  if (lines.length <= 2) {
    lines.push("No Package.resolved or Podfile.lock found in the project.");
  }

  return lines.join("\n");
}

function formatChildren(
  nodes: DependencyNode[],
): { name: string; children?: { name: string; children?: unknown[] }[] }[] {
  return nodes.map((n) => ({
    name: `${n.name} (${n.version ?? "?"})`,
    children: n.children.length > 0 ? formatChildren(n.children) : undefined,
  }));
}

import fg from "fast-glob";
import { access } from "node:fs/promises";
import { join, basename } from "node:path";
import type { XcodeProjectInfo } from "../types/xcode.js";

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function detectProject(rootPath: string): Promise<XcodeProjectInfo> {
  // Check for .xcworkspace
  const workspaces = await fg("*.xcworkspace", {
    cwd: rootPath,
    onlyDirectories: true,
    deep: 1,
  });

  if (workspaces.length > 0) {
    const projectPaths = await fg("**/*.xcodeproj", {
      cwd: rootPath,
      onlyDirectories: true,
      deep: 3,
      ignore: ["**/Pods/**"],
    });

    return {
      type: "xcworkspace",
      rootPath,
      projectPaths: projectPaths.map((p) => join(rootPath, p)),
      packageSwiftPath: (await exists(join(rootPath, "Package.swift")))
        ? join(rootPath, "Package.swift")
        : undefined,
      podfilePath: (await exists(join(rootPath, "Podfile")))
        ? join(rootPath, "Podfile")
        : undefined,
    };
  }

  // Check for .xcodeproj
  const projects = await fg("*.xcodeproj", {
    cwd: rootPath,
    onlyDirectories: true,
    deep: 1,
  });

  if (projects.length > 0) {
    return {
      type: "xcodeproj",
      rootPath,
      projectPaths: projects.map((p) => join(rootPath, p)),
      packageSwiftPath: (await exists(join(rootPath, "Package.swift")))
        ? join(rootPath, "Package.swift")
        : undefined,
      podfilePath: (await exists(join(rootPath, "Podfile")))
        ? join(rootPath, "Podfile")
        : undefined,
    };
  }

  // Check for Package.swift (SPM)
  if (await exists(join(rootPath, "Package.swift"))) {
    return {
      type: "spm",
      rootPath,
      projectPaths: [],
      packageSwiftPath: join(rootPath, "Package.swift"),
    };
  }

  // Check for Podfile (CocoaPods)
  if (await exists(join(rootPath, "Podfile"))) {
    return {
      type: "cocoapods",
      rootPath,
      projectPaths: [],
      podfilePath: join(rootPath, "Podfile"),
    };
  }

  // Try subdirectories (common pattern: project inside a subfolder)
  const subWorkspaces = await fg("**/*.xcworkspace", {
    cwd: rootPath,
    onlyDirectories: true,
    deep: 2,
    ignore: ["**/Pods/**", "**/DerivedData/**"],
  });

  if (subWorkspaces.length > 0) {
    return detectProject(join(rootPath, subWorkspaces[0], ".."));
  }

  throw new Error(
    `No Xcode project found at ${rootPath}. Expected .xcworkspace, .xcodeproj, Package.swift, or Podfile.`,
  );
}

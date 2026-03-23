import { readFile } from "node:fs/promises";
import type { PackageSwiftData, PackageSwiftTarget, PackageSwiftDependency, PackageSwiftProduct, PackageSwiftExternalDep } from "../types/spm.js";

/**
 * Parse Package.swift using regex patterns.
 * Not a full Swift parser — handles common patterns used in real projects.
 */
export async function parsePackageSwift(filePath: string): Promise<PackageSwiftData> {
  const source = await readFile(filePath, "utf-8");
  return parsePackageSwiftSource(source);
}

export function parsePackageSwiftSource(source: string): PackageSwiftData {
  return {
    targets: parseTargets(source),
    products: parseProducts(source),
    externalDependencies: parseExternalDependencies(source),
  };
}

function parseTargets(source: string): PackageSwiftTarget[] {
  const targets: PackageSwiftTarget[] = [];

  // Match .target(...), .testTarget(...), .executableTarget(...)
  const targetRegex = /\.(target|testTarget|executableTarget|plugin)\s*\(\s*\n?\s*name:\s*"([^"]+)"([^)]*(?:\([^)]*\)[^)]*)*)\)/gs;

  let match: RegExpExecArray | null;
  while ((match = targetRegex.exec(source)) !== null) {
    const typeStr = match[1];
    const name = match[2];
    const body = match[3];

    const type = typeStr === "testTarget" ? "test"
      : typeStr === "executableTarget" ? "executable"
      : typeStr === "plugin" ? "plugin"
      : "regular";

    const dependencies = parseDependencyList(body);

    const pathMatch = body.match(/path:\s*"([^"]+)"/);

    targets.push({
      name,
      type,
      dependencies,
      path: pathMatch?.[1],
    });
  }

  return targets;
}

function parseDependencyList(body: string): PackageSwiftDependency[] {
  const deps: PackageSwiftDependency[] = [];

  // Extract dependencies array content
  const depsMatch = body.match(/dependencies:\s*\[([\s\S]*?)(?:\]\s*[,)])/);
  if (!depsMatch) return deps;

  const depsBody = depsMatch[1];

  // .product(name: "X", package: "Y")
  const productRegex = /\.product\s*\(\s*name:\s*"([^"]+)"\s*,\s*package:\s*"([^"]+)"\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = productRegex.exec(depsBody)) !== null) {
    deps.push({ name: m[1], package: m[2], isProduct: true });
  }

  // Simple string dependencies: "ModuleName"
  const simpleRegex = /"([^"]+)"/g;
  const allStrings: string[] = [];
  while ((m = simpleRegex.exec(depsBody)) !== null) {
    allStrings.push(m[1]);
  }

  // Filter out strings already captured as product names/packages
  const productNames = new Set(deps.flatMap((d) => [d.name, d.package ?? ""]));
  for (const s of allStrings) {
    if (!productNames.has(s)) {
      deps.push({ name: s, isProduct: false });
    }
  }

  return deps;
}

function parseProducts(source: string): PackageSwiftProduct[] {
  const products: PackageSwiftProduct[] = [];

  // .library(name: "X", type: .dynamic/.static, targets: ["Y"])
  const libRegex = /\.library\s*\(\s*name:\s*"([^"]+)"(?:\s*,\s*type:\s*\.(\w+))?\s*,\s*targets:\s*\[([^\]]*)\]\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = libRegex.exec(source)) !== null) {
    const targets = [...m[3].matchAll(/"([^"]+)"/g)].map((t) => t[1]);
    products.push({
      name: m[1],
      type: "library",
      libraryType: (m[2] as "dynamic" | "static") || undefined,
      targets,
    });
  }

  // .executable(name: "X", targets: ["Y"])
  const execRegex = /\.executable\s*\(\s*name:\s*"([^"]+)"\s*,\s*targets:\s*\[([^\]]*)\]\s*\)/g;
  while ((m = execRegex.exec(source)) !== null) {
    const targets = [...m[2].matchAll(/"([^"]+)"/g)].map((t) => t[1]);
    products.push({ name: m[1], type: "executable", targets });
  }

  return products;
}

function parseExternalDependencies(source: string): PackageSwiftExternalDep[] {
  const deps: PackageSwiftExternalDep[] = [];

  // .package(url: "https://...", from: "1.0.0")
  // .package(url: "https://...", .upToNextMajor(from: "1.0.0"))
  // .package(url: "https://...", branch: "main")
  // .package(url: "https://...", revision: "abc123")
  // .package(url: "https://...", exact: "1.0.0")
  const pkgRegex = /\.package\s*\(\s*url:\s*"([^"]+)"[^)]*\)/g;
  let m: RegExpExecArray | null;
  while ((m = pkgRegex.exec(source)) !== null) {
    const url = m[1];
    const body = m[0];

    const dep: PackageSwiftExternalDep = { url };

    // Extract version
    const fromMatch = body.match(/from:\s*"([^"]+)"/);
    const exactMatch = body.match(/exact:\s*"([^"]+)"/);
    const branchMatch = body.match(/branch:\s*"([^"]+)"/);
    const revisionMatch = body.match(/revision:\s*"([^"]+)"/);

    if (fromMatch) dep.version = fromMatch[1];
    else if (exactMatch) dep.version = exactMatch[1];
    if (branchMatch) dep.branch = branchMatch[1];
    if (revisionMatch) dep.revision = revisionMatch[1];

    // Derive name from URL
    const nameMatch = url.match(/\/([^/]+?)(?:\.git)?$/);
    if (nameMatch) dep.name = nameMatch[1];

    deps.push(dep);
  }

  return deps;
}

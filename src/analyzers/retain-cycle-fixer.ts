import { readFile, writeFile } from "node:fs/promises";
import { scanSwiftFiles } from "../utils/file-scanner.js";

export interface FixOptions {
  projectPath: string;
  targetPaths?: string[];
  excludePatterns?: string[];
  dryRun?: boolean;
  categories?: string[];
}

interface FixResult {
  filePath: string;
  line: number;
  category: string;
  before: string;
  after: string;
}

export async function fixRetainCycles(options: FixOptions): Promise<string> {
  const {
    projectPath,
    targetPaths,
    excludePatterns = [],
    dryRun = true,
    categories = ["strong-delegate", "weak-self", "notification-leak"],
  } = options;

  let swiftFiles: string[];
  if (targetPaths && targetPaths.length > 0) {
    const { scanFiles } = await import("../utils/file-scanner.js");
    swiftFiles = await scanFiles({
      patterns: targetPaths.map((p) => (p.endsWith(".swift") ? p : `${p}/**/*.swift`)),
      cwd: projectPath,
      ignore: excludePatterns,
    });
  } else {
    swiftFiles = await scanSwiftFiles(projectPath, excludePatterns);
  }

  const allFixes: FixResult[] = [];
  const modifiedFiles: string[] = [];

  for (const filePath of swiftFiles) {
    try {
      const source = await readFile(filePath, "utf-8");
      const isClass = /\bclass\s+\w+/.test(source);
      if (!isClass) continue;

      let modified = source;
      const relativePath = filePath.replace(projectPath + "/", "");
      const fixes: FixResult[] = [];

      if (categories.includes("strong-delegate")) {
        const result = fixStrongDelegates(modified, relativePath);
        modified = result.source;
        fixes.push(...result.fixes);
      }

      if (categories.includes("weak-self")) {
        const result = fixMissingWeakSelf(modified, relativePath);
        modified = result.source;
        fixes.push(...result.fixes);
      }

      if (categories.includes("notification-leak")) {
        const result = fixNotificationLeaks(modified, relativePath);
        modified = result.source;
        fixes.push(...result.fixes);
      }

      if (fixes.length > 0) {
        allFixes.push(...fixes);
        if (!dryRun) {
          await writeFile(filePath, modified, "utf-8");
          modifiedFiles.push(relativePath);
        }
      }
    } catch {
      // Skip files that can't be read
    }
  }

  return formatFixResult(allFixes, modifiedFiles, dryRun);
}

/**
 * Fix: Add `weak` to delegate/dataSource properties.
 */
function fixStrongDelegates(
  source: string,
  filePath: string,
): { source: string; fixes: FixResult[] } {
  const fixes: FixResult[] = [];
  const lines = source.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Skip protocol requirements, computed properties, comments
    if (trimmed.startsWith("//")) continue;
    if (/\{\s*get\s*(set\s*)?\}/.test(trimmed)) continue;
    if (/\{\s*(return\s|self\b)/.test(trimmed)) continue;
    if (trimmed.includes("weak ") || trimmed.includes("unowned ")) continue;

    // Match: var delegate: SomeType? or var dataSource: SomeType?
    const match = trimmed.match(
      /^((?:(?:public|internal|private|fileprivate|open)\s+)?)var\s+(\w*(?:delegate|dataSource|datasource)\w*)\s*:\s*(\S+\??)/i,
    );

    if (match) {
      const propType = match[3];
      // Skip closure types
      if (propType.includes("->") || propType.includes("()")) continue;

      const indent = line.match(/^(\s*)/)?.[1] ?? "";
      const accessModifier = match[1].trim();
      const propName = match[2];
      // Ensure type is optional for weak
      const optionalType = propType.endsWith("?") ? propType : `${propType}?`;
      const rest = trimmed.substring(trimmed.indexOf(propType) + propType.length);

      const before = line;
      const prefix = accessModifier ? `${accessModifier} ` : "";
      const after = `${indent}${prefix}weak var ${propName}: ${optionalType}${rest}`;

      lines[i] = after;
      fixes.push({ filePath, line: i + 1, category: "strong-delegate", before: before.trim(), after: after.trim() });
    }
  }

  return { source: lines.join("\n"), fixes };
}

/**
 * Fix: Add [weak self] to closures that use self without it.
 * Only fixes clear patterns where we can safely insert [weak self].
 */
function fixMissingWeakSelf(
  source: string,
  filePath: string,
): { source: string; fixes: FixResult[] } {
  const fixes: FixResult[] = [];
  const lines = source.split("\n");

  // Escaping closure patterns that need [weak self]
  const escapingPatterns = [
    /\.(subscribe|bind|drive|observe)\s*\(\s*onNext:\s*\{$/,
    /\.(subscribe|bind|drive|observe)\s*\{$/,
    /\.(subscribe|bind|drive)\s*\(\s*onNext:\s*\{\s*$/,
    /completion\s*:\s*\{$/,
    /completionHandler\s*:\s*\{$/,
    /DispatchQueue\.\w+\.async\s*\{$/,
    /DispatchQueue\.\w+\.asyncAfter.*\{$/,
    /UIView\.animate.*\{$/,
  ];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();

    // Check if this line opens an escaping closure
    const isEscaping = escapingPatterns.some((p) => p.test(trimmed));
    if (!isEscaping) continue;

    // Check if [weak self] is already present
    if (trimmed.includes("weak self") || trimmed.includes("unowned self")) continue;

    // Check next line for [weak self]
    if (i + 1 < lines.length) {
      const nextTrimmed = lines[i + 1].trim();
      if (nextTrimmed.includes("weak self") || nextTrimmed.includes("unowned self")) continue;
    }

    // Check if self is actually used in this closure (look ahead up to 20 lines or closing brace)
    let usesSelf = false;
    let braceCount = 0;
    let closureEndLine = -1;
    for (let j = i; j < Math.min(i + 30, lines.length); j++) {
      for (const ch of lines[j]) {
        if (ch === "{") braceCount++;
        if (ch === "}") braceCount--;
      }
      if (j > i && /\bself\./.test(lines[j])) {
        usesSelf = true;
      }
      if (braceCount === 0 && j > i) {
        closureEndLine = j;
        break;
      }
    }

    if (!usesSelf) continue;

    // Insert [weak self] and guard let self
    const indent = lines[i].match(/^(\s*)/)?.[1] ?? "";
    const closureIndent = indent + "    ";

    // Modify the closure opening to add [weak self]
    const before = lines[i];
    lines[i] = lines[i].replace(/\{\s*$/, "{ [weak self] in");

    // Insert guard let self on the next line
    const guardLine = `${closureIndent}guard let self = self else { return }`;
    lines.splice(i + 1, 0, guardLine);

    const after = lines[i];
    fixes.push({
      filePath,
      line: i + 1,
      category: "weak-self",
      before: before.trim(),
      after: `${after.trim()} + guard let self`,
    });

    // Skip ahead past the inserted line
    i++;
  }

  return { source: lines.join("\n"), fixes };
}

/**
 * Fix: Add removeObserver in deinit for NotificationCenter observers.
 */
function fixNotificationLeaks(
  source: string,
  filePath: string,
): { source: string; fixes: FixResult[] } {
  const fixes: FixResult[] = [];

  // Check if there's addObserver without removeObserver
  const hasAddObserver = /\.addObserver\(self/.test(source) ||
    /NotificationCenter\.default\.addObserver\(/.test(source);
  const hasRemoveObserver = /\.removeObserver\(self/.test(source) ||
    /NotificationCenter\.default\.removeObserver/.test(source);

  if (!hasAddObserver || hasRemoveObserver) return { source, fixes };

  // Check if deinit exists
  const lines = source.split("\n");
  let deinitLine = -1;
  let lastClosingBrace = -1;

  for (let i = 0; i < lines.length; i++) {
    if (/^\s*deinit\s*\{/.test(lines[i])) {
      deinitLine = i;
    }
    // Find the last closing brace of the class (approximate)
    if (/^\s*\}\s*$/.test(lines[i])) {
      lastClosingBrace = i;
    }
  }

  if (deinitLine !== -1) {
    // Add removeObserver inside existing deinit
    const indent = lines[deinitLine].match(/^(\s*)/)?.[1] ?? "";
    const insertLine = `${indent}    NotificationCenter.default.removeObserver(self)`;
    lines.splice(deinitLine + 1, 0, insertLine);

    fixes.push({
      filePath,
      line: deinitLine + 1,
      category: "notification-leak",
      before: "(no removeObserver)",
      after: "Added removeObserver(self) in deinit",
    });
  } else if (lastClosingBrace !== -1) {
    // Add deinit with removeObserver before the last closing brace
    const indent = "    ";
    const deinitBlock = [
      "",
      `${indent}deinit {`,
      `${indent}    NotificationCenter.default.removeObserver(self)`,
      `${indent}}`,
    ];
    lines.splice(lastClosingBrace, 0, ...deinitBlock);

    fixes.push({
      filePath,
      line: lastClosingBrace,
      category: "notification-leak",
      before: "(no deinit)",
      after: "Added deinit { removeObserver(self) }",
    });
  }

  return { source: lines.join("\n"), fixes };
}

function formatFixResult(
  fixes: FixResult[],
  modifiedFiles: string[],
  dryRun: boolean,
): string {
  const lines: string[] = [];

  lines.push(`## Auto-Fix Results${dryRun ? " (Dry Run)" : ""}\n`);

  if (fixes.length === 0) {
    lines.push("No auto-fixable issues found.");
    return lines.join("\n");
  }

  lines.push(`- **Total fixes:** ${fixes.length}`);

  // Count by category
  const categories = new Map<string, number>();
  for (const fix of fixes) {
    categories.set(fix.category, (categories.get(fix.category) ?? 0) + 1);
  }

  const catLabels: Record<string, string> = {
    "strong-delegate": "Add `weak` to delegates",
    "weak-self": "Add `[weak self]` + `guard let self`",
    "notification-leak": "Add `removeObserver` in deinit",
  };

  for (const [cat, count] of categories) {
    lines.push(`  - ${catLabels[cat] ?? cat}: ${count}`);
  }

  if (dryRun) {
    lines.push(`\n**This is a dry run.** No files were modified.`);
    lines.push(`Set \`dryRun: false\` to apply these fixes.\n`);
  } else {
    lines.push(`\n**${modifiedFiles.length} files modified:**`);
    for (const f of modifiedFiles) {
      lines.push(`  - ${f}`);
    }
  }

  // Show each fix
  lines.push("\n### Fixes\n");
  for (const fix of fixes) {
    lines.push(`**${fix.filePath}:${fix.line}** (${fix.category})`);
    lines.push(`  Before: \`${fix.before}\``);
    lines.push(`  After:  \`${fix.after}\`\n`);
  }

  return lines.join("\n");
}

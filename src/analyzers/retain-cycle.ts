import { readFile } from "node:fs/promises";
import { scanSwiftFiles } from "../utils/file-scanner.js";
import { formatTable } from "../utils/formatter.js";

export interface RetainCycleOptions {
  projectPath: string;
  targetPaths?: string[];
  excludePatterns?: string[];
}

interface RetainIssue {
  filePath: string;
  line: number;
  severity: "high" | "medium" | "low";
  category: string;
  code: string;
  description: string;
  fix: string;
}

export async function analyzeRetainCycles(options: RetainCycleOptions): Promise<string> {
  const { projectPath, targetPaths, excludePatterns = [] } = options;

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

  const allIssues: RetainIssue[] = [];

  const batchSize = 50;
  for (let i = 0; i < swiftFiles.length; i += batchSize) {
    const batch = swiftFiles.slice(i, i + batchSize);
    const results = await Promise.all(
      batch.map(async (fp) => {
        try {
          const source = await readFile(fp, "utf-8");
          const relativePath = fp.replace(projectPath + "/", "");
          return analyzeFile(source, relativePath);
        } catch {
          return [];
        }
      }),
    );
    allIssues.push(...results.flat());
  }

  return formatResult(allIssues, swiftFiles.length);
}

type TypeKind = "class" | "struct" | "enum" | "protocol" | "actor" | "extension" | null;

/**
 * Build a per-line map of which type scope each line belongs to.
 * Returns an array where lineScopes[i] = the TypeKind of the enclosing type at line i.
 * Handles nested types by tracking brace depth per type declaration.
 */
function buildLineScopes(lines: string[]): TypeKind[] {
  const scopes: TypeKind[] = new Array(lines.length).fill(null);
  const stack: { kind: TypeKind; braceDepth: number }[] = [];
  let braceDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith("//")) {
      scopes[i] = stack.length > 0 ? stack[stack.length - 1].kind : null;
      continue;
    }

    // Detect type declarations
    const typeMatch = trimmed.match(
      /\b(class|struct|enum|protocol|actor|extension)\s+\w+/,
    );
    if (typeMatch && trimmed.includes("{")) {
      const kind = typeMatch[1] as TypeKind;
      stack.push({ kind, braceDepth });
    }

    // Count braces
    for (const ch of trimmed) {
      if (ch === "{") braceDepth++;
      if (ch === "}") {
        braceDepth--;
        // Check if we're closing the current type scope
        if (stack.length > 0 && braceDepth === stack[stack.length - 1].braceDepth) {
          stack.pop();
        }
      }
    }

    scopes[i] = stack.length > 0 ? stack[stack.length - 1].kind : null;
  }

  return scopes;
}

function analyzeFile(source: string, filePath: string): RetainIssue[] {
  const issues: RetainIssue[] = [];
  const lines = source.split("\n");

  // Build per-line type scope map (class vs struct vs protocol etc.)
  const lineScopes = buildLineScopes(lines);
  const hasClass = lineScopes.some((s) => s === "class" || s === "actor");

  issues.push(...detectStrongSelfInClosures(lines, filePath, lineScopes));
  issues.push(...detectStrongDelegates(lines, filePath, lineScopes));
  issues.push(...detectTimerRetainCycles(lines, filePath));
  issues.push(...detectNotificationCenterLeaks(lines, filePath));
  issues.push(...detectViewModelRetainCycles(lines, filePath, source, lineScopes));
  issues.push(...detectDispatchWorkRetainCycles(lines, filePath));
  issues.push(...detectStrongClosureProperties(lines, filePath, lineScopes));

  return issues;
}

/**
 * Check if a line is a protocol requirement or computed property (not stored).
 * e.g., `var output: SomeType { get }` or `var output: SomeType { self }`
 */
function isComputedOrProtocolProperty(line: string): boolean {
  const trimmed = line.trim();
  // Protocol requirement: `var x: Type { get }` or `var x: Type { get set }`
  if (/\{\s*get\s*(set\s*)?\}/.test(trimmed)) return true;
  // Computed property: `var x: Type { return ... }` or `var x: Type { self }`
  if (/\{\s*(return\s|self\b)/.test(trimmed)) return true;
  return false;
}

/**
 * Detect closures that capture self without [weak self].
 * Checks: escaping closures, completion handlers, network callbacks, rx subscriptions
 */
function detectStrongSelfInClosures(lines: string[], filePath: string, lineScopes: TypeKind[]): RetainIssue[] {
  const issues: RetainIssue[] = [];
  // Only classes/actors have retain cycles with self
  if (!lineScopes.some((s) => s === "class" || s === "actor")) return issues;

  let inBlockComment = false;
  let braceDepth = 0;

  // Track closure contexts
  const closureStack: { startLine: number; hasWeakSelf: boolean; isEscaping: boolean; context: string }[] = [];

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    // Skip comments
    if (inBlockComment) {
      if (line.includes("*/")) inBlockComment = false;
      continue;
    }
    if (line.includes("/*")) {
      if (!line.includes("*/")) inBlockComment = true;
      continue;
    }
    const commentIdx = line.indexOf("//");
    if (commentIdx !== -1) line = line.substring(0, commentIdx);

    const trimmed = line.trim();

    // ── Allowlist approach ──
    // ONLY flag patterns that are KNOWN to retain closures and cause real retain cycles.
    // Everything else is assumed safe. This way new APIs don't require updates.
    const escapingPatterns = [
      // RxSwift/RxCocoa — subscriptions hold closures until disposed (the #1 source of retain cycles)
      /\.(subscribe|bind|drive|observe)\s*\(\s*onNext:?\s*\{/,
      /\.(subscribe|bind|drive|observe)\s*\{/,
      // Explicit @escaping annotation — developer marked it as escaping
      /@escaping/,
      // Stored completion/handler params — these closures outlive the call site
      /completion\s*:\s*\{/,
      /completionHandler\s*:\s*\{/,
      // Network callbacks — closures retained until response arrives
      /\.dataTask\s*\(.*\{/,
      /URLSession.*completionHandler.*\{/,
    ];

    const isEscapingContext = escapingPatterns.some((p) => p.test(trimmed));

    // Check for closure opening with or without capture list
    if (trimmed.includes("{")) {
      const hasWeakSelf = /\[\s*weak\s+self\s*\]/.test(trimmed) ||
        /\[\s*unowned\s+self\s*\]/.test(trimmed);
      const hasWeakSelfMulti = /\[.*weak\s+self.*\]/.test(trimmed);

      // Check if this brace is a closure (has `in` keyword)
      const isClosureLine = /\{\s*(\[.*\]\s*)?\s*(\w+.*\s+)?in\s*$/.test(trimmed) ||
        /\{\s*(\[.*\]\s*)?\s*$/.test(trimmed);

      // Look ahead for `in` keyword (multi-line closure)
      let looksLikeClosure = isClosureLine;
      if (!looksLikeClosure && i + 1 < lines.length) {
        const nextTrimmed = lines[i + 1].trim();
        looksLikeClosure = /^\[?\s*weak\s+self\s*\]?\s*in/.test(nextTrimmed) ||
          /^\[.*\]\s*in/.test(nextTrimmed) ||
          /^\w+.*\s+in\s*$/.test(nextTrimmed);
      }
      // Also check line i+1 for [weak self]
      if (i + 1 < lines.length) {
        const nextLine = lines[i + 1].trim();
        if (/\[\s*weak\s+self\s*\]/.test(nextLine) || /\[\s*unowned\s+self\s*\]/.test(nextLine)) {
          closureStack.push({
            startLine: i + 1,
            hasWeakSelf: true,
            isEscaping: isEscapingContext,
            context: trimmed.substring(0, 60),
          });
          continue;
        }
      }

      if (isEscapingContext || looksLikeClosure) {
        closureStack.push({
          startLine: i + 1,
          hasWeakSelf: hasWeakSelf || hasWeakSelfMulti,
          isEscaping: isEscapingContext,
          context: trimmed.substring(0, 60),
        });
      }
    }

    // Check for `self.` usage without [weak self] in escaping closures
    if (closureStack.length > 0) {
      const currentClosure = closureStack[closureStack.length - 1];
      if (!currentClosure.hasWeakSelf && currentClosure.isEscaping) {
        const selfUsage = trimmed.match(/\bself\.\w+/);
        if (selfUsage) {
          issues.push({
            filePath,
            line: i + 1,
            severity: "high",
            category: "strong-self-in-closure",
            code: trimmed.substring(0, 80),
            description: `\`self.${selfUsage[0].substring(5)}\` captured strongly in escaping closure without [weak self]`,
            fix: "Add [weak self] to the closure capture list, then use guard let self = self else { return }",
          });
        }
      }
    }

    // Track brace closing for closure stack
    if (trimmed.includes("}") && closureStack.length > 0) {
      closureStack.pop();
    }
  }

  return issues;
}

/**
 * Detect delegates/datasources not declared as weak.
 */
function detectStrongDelegates(lines: string[], filePath: string, lineScopes: TypeKind[]): RetainIssue[] {
  const issues: RetainIssue[] = [];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith("//")) continue;
    // Only flag delegates inside class/actor — structs don't have retain cycles
    const scope = lineScopes[i];
    if (scope !== "class" && scope !== "actor") continue;
    // Skip protocol requirements and computed properties
    if (isComputedOrProtocolProperty(trimmed)) continue;

    // var delegate: SomeDelegate (without weak)
    const delegateMatch = trimmed.match(
      /^(?:(?:public|internal|private|fileprivate|open)\s+)?(?!weak\s)(?!unowned\s)(var|let)\s+(\w*(?:delegate|dataSource|datasource|listener|observer|handler|callback)\w*)\s*:\s*(\S+)/i,
    );

    if (delegateMatch) {
      const propKeyword = delegateMatch[1];
      const propName = delegateMatch[2];
      const propType = delegateMatch[3];

      // Skip if it's a closure type
      if (propType.includes("->") || propType.includes("()")) continue;
      // Skip if it's already optional with weak semantics implied
      if (trimmed.includes("weak ")) continue;

      issues.push({
        filePath,
        line: i + 1,
        severity: "high",
        category: "strong-delegate",
        code: trimmed.substring(0, 80),
        description: `\`${propName}\` (${propType}) is not declared as \`weak\` — likely retain cycle with delegate pattern`,
        fix: `Change to: weak var ${propName}: ${propType}?`,
      });
    }
  }

  return issues;
}

/**
 * Detect Timer.scheduledTimer without invalidation or with strong self.
 */
function detectTimerRetainCycles(lines: string[], filePath: string): RetainIssue[] {
  const issues: RetainIssue[] = [];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith("//")) continue;

    // Timer.scheduledTimer with target: self
    if (/Timer\.scheduledTimer/.test(trimmed) && /target:\s*self/.test(trimmed)) {
      issues.push({
        filePath,
        line: i + 1,
        severity: "high",
        category: "timer-retain",
        code: trimmed.substring(0, 80),
        description: "Timer.scheduledTimer with target: self creates a strong reference cycle — Timer retains self",
        fix: "Use Timer.scheduledTimer with block-based API and [weak self], or invalidate timer in deinit",
      });
    }

    // Timer with closure but no [weak self]
    if (/Timer\.scheduledTimer/.test(trimmed) && trimmed.includes("{") && !trimmed.includes("weak self")) {
      // Check next few lines for weak self
      let hasWeakSelf = false;
      for (let j = i; j < Math.min(i + 3, lines.length); j++) {
        if (lines[j].includes("weak self")) { hasWeakSelf = true; break; }
      }
      if (!hasWeakSelf) {
        issues.push({
          filePath,
          line: i + 1,
          severity: "medium",
          category: "timer-retain",
          code: trimmed.substring(0, 80),
          description: "Timer closure may capture self strongly",
          fix: "Add [weak self] to the Timer closure",
        });
      }
    }
  }

  return issues;
}

/**
 * Detect NotificationCenter.addObserver without removal.
 */
function detectNotificationCenterLeaks(lines: string[], filePath: string): RetainIssue[] {
  const issues: RetainIssue[] = [];
  const source = lines.join("\n");

  const hasAddObserver = /NotificationCenter\.default\.addObserver\(/.test(source) ||
    /\.addObserver\(self/.test(source);
  const hasRemoveObserver = /NotificationCenter\.default\.removeObserver/.test(source) ||
    /\.removeObserver\(self/.test(source);

  if (hasAddObserver && !hasRemoveObserver) {
    // Find the addObserver line
    for (let i = 0; i < lines.length; i++) {
      if (/\.addObserver\(/.test(lines[i])) {
        issues.push({
          filePath,
          line: i + 1,
          severity: "medium",
          category: "notification-leak",
          code: lines[i].trim().substring(0, 80),
          description: "NotificationCenter observer added but never removed — object won't be deallocated",
          fix: "Call NotificationCenter.default.removeObserver(self) in deinit",
        });
        break;
      }
    }
  }

  // Block-based addObserver without storing token
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (/NotificationCenter\.default\.addObserver\(forName:/.test(trimmed)) {
      // Check if return value is stored
      if (!trimmed.includes("=") && !trimmed.startsWith("let ") && !trimmed.startsWith("var ")) {
        issues.push({
          filePath,
          line: i + 1,
          severity: "medium",
          category: "notification-leak",
          code: trimmed.substring(0, 80),
          description: "Block-based observer token not stored — cannot remove observer later",
          fix: "Store the return value and call removeObserver with the token in deinit",
        });
      }
    }
  }

  return issues;
}

/**
 * Detect ViewController ↔ ViewModel strong reference patterns.
 */
function detectViewModelRetainCycles(lines: string[], filePath: string, source: string, lineScopes: TypeKind[]): RetainIssue[] {
  const issues: RetainIssue[] = [];

  // Check if this is a ViewModel that holds a strong reference to a ViewController
  const isViewModel = /ViewModel/.test(filePath) || /\bclass\s+\w*ViewModel/.test(source);

  if (isViewModel) {
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (trimmed.startsWith("//")) continue;
      // Only flag inside class/actor — struct ViewModel doesn't have retain cycles
      const scope = lineScopes[i];
      if (scope !== "class" && scope !== "actor") continue;
      // Skip protocol requirements and computed properties
      if (isComputedOrProtocolProperty(trimmed)) continue;

      // ViewModel holding strong ref to ViewController/View/Coordinator
      const vcRefMatch = trimmed.match(
        /^(?:(?:public|internal|private|fileprivate)\s+)?(?!weak\s)(?!unowned\s)(?:var|let)\s+(\w+)\s*:\s*(\w*(?:ViewController|View|Coordinator|Controller)\w*)/,
      );

      if (vcRefMatch) {
        if (trimmed.includes("weak ") || trimmed.includes("unowned ")) continue;
        // Skip Input/Output protocol patterns (common MVVM pattern, not stored refs)
        if (/Input|Output/.test(vcRefMatch[2])) continue;
        issues.push({
          filePath,
          line: i + 1,
          severity: "high",
          category: "viewmodel-retain",
          code: trimmed.substring(0, 80),
          description: `ViewModel holds strong reference to \`${vcRefMatch[2]}\` — VC→VM→VC retain cycle`,
          fix: `Declare as: weak var ${vcRefMatch[1]}: ${vcRefMatch[2]}?`,
        });
      }
    }
  }

  // Check if ViewController holds closures that might capture viewModel
  const isViewController = /ViewController/.test(filePath) || /\bclass\s+\w*ViewController/.test(source);
  if (isViewController) {
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      // Stored closure property that likely captures self
      if (/^(?:var|let)\s+\w+\s*:\s*\(.*\)\s*->\s*/.test(trimmed) && !trimmed.includes("weak")) {
        issues.push({
          filePath,
          line: i + 1,
          severity: "low",
          category: "closure-property",
          code: trimmed.substring(0, 80),
          description: "Stored closure property in ViewController may capture self or ViewModel strongly",
          fix: "Ensure the closure captures [weak self] when assigned, or make the property weak/optional",
        });
      }
    }
  }

  return issues;
}

/**
 * Detect DispatchWorkItem / DispatchQueue strong captures.
 */
function detectDispatchWorkRetainCycles(lines: string[], filePath: string): RetainIssue[] {
  const issues: RetainIssue[] = [];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith("//")) continue;

    // DispatchWorkItem without [weak self]
    if (/DispatchWorkItem\s*\{/.test(trimmed) && !trimmed.includes("weak self")) {
      let hasWeakSelf = false;
      for (let j = i; j < Math.min(i + 3, lines.length); j++) {
        if (lines[j].includes("weak self")) { hasWeakSelf = true; break; }
      }
      if (!hasWeakSelf && lines.slice(i, Math.min(i + 10, lines.length)).some((l) => l.includes("self."))) {
        issues.push({
          filePath,
          line: i + 1,
          severity: "medium",
          category: "dispatch-retain",
          code: trimmed.substring(0, 80),
          description: "DispatchWorkItem captures self strongly — stored work items create retain cycles",
          fix: "Add [weak self] to the DispatchWorkItem closure",
        });
      }
    }
  }

  return issues;
}

/**
 * Detect stored closure properties in classes that could capture self.
 */
function detectStrongClosureProperties(lines: string[], filePath: string, lineScopes: TypeKind[]): RetainIssue[] {
  const issues: RetainIssue[] = [];
  if (!lineScopes.some((s) => s === "class" || s === "actor")) return issues;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith("//")) continue;

    // var onComplete: ((Result) -> Void)? — stored closure that might capture self
    const closurePropMatch = trimmed.match(
      /^(?:(?:public|internal|private|fileprivate)\s+)?var\s+(\w+(?:Handler|Completion|Callback|Block|Action|Closure|OnComplete|OnSuccess|OnFailure|OnError)\w*)\s*:/i,
    );

    if (closurePropMatch && !trimmed.includes("weak")) {
      // Only flag inside class/actor
      if (lineScopes[i] !== "class" && lineScopes[i] !== "actor") continue;
      issues.push({
        filePath,
        line: i + 1,
        severity: "low",
        category: "closure-property",
        code: trimmed.substring(0, 80),
        description: `Stored closure \`${closurePropMatch[1]}\` in class — callers must use [weak self] when setting this`,
        fix: "Document that callers should capture [weak self], or nil out the closure when no longer needed",
      });
    }
  }

  return issues;
}

function formatResult(issues: RetainIssue[], totalFiles: number): string {
  const lines: string[] = [];

  const high = issues.filter((i) => i.severity === "high");
  const medium = issues.filter((i) => i.severity === "medium");
  const low = issues.filter((i) => i.severity === "low");

  lines.push("## Memory Leak & Retain Cycle Analysis\n");
  lines.push(`- **Files scanned:** ${totalFiles}`);
  lines.push(`- **Issues found:** ${issues.length}`);
  lines.push(`  - 🔴 High: ${high.length}`);
  lines.push(`  - 🟡 Medium: ${medium.length}`);
  lines.push(`  - 🟢 Low: ${low.length}\n`);

  if (issues.length === 0) {
    lines.push("No potential memory leaks or retain cycles detected.");
    return lines.join("\n");
  }

  // Category summary
  const categories = new Map<string, number>();
  for (const issue of issues) {
    categories.set(issue.category, (categories.get(issue.category) ?? 0) + 1);
  }

  lines.push("### Issue Categories");
  const catLabels: Record<string, string> = {
    "strong-self-in-closure": "Strong self in escaping closure (missing [weak self])",
    "strong-delegate": "Delegate not declared as weak",
    "timer-retain": "Timer retaining self",
    "notification-leak": "NotificationCenter observer leak",
    "viewmodel-retain": "ViewModel ↔ ViewController retain cycle",
    "dispatch-retain": "DispatchWorkItem strong capture",
    "closure-property": "Stored closure property (potential capture)",
  };

  const catRows = [...categories.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([cat, count]) => [catLabels[cat] ?? cat, String(count)]);
  lines.push(formatTable(["Category", "Count"], catRows));

  if (high.length > 0) {
    lines.push(`\n### 🔴 High Severity (${high.length})\n`);
    lines.push("These are very likely to cause memory leaks:\n");
    for (const issue of high) {
      lines.push(`**${issue.filePath}:${issue.line}** — ${issue.category}`);
      lines.push(`  ${issue.description}`);
      lines.push(`  \`${issue.code}\``);
      lines.push(`  **Fix:** ${issue.fix}\n`);
    }
  }

  if (medium.length > 0) {
    lines.push(`\n### 🟡 Medium Severity (${medium.length})\n`);
    lines.push("These may cause leaks depending on usage:\n");
    for (const issue of medium) {
      lines.push(`**${issue.filePath}:${issue.line}** — ${issue.category}`);
      lines.push(`  ${issue.description}`);
      lines.push(`  \`${issue.code}\``);
      lines.push(`  **Fix:** ${issue.fix}\n`);
    }
  }

  if (low.length > 0) {
    lines.push(`\n### 🟢 Low Severity (${low.length})\n`);
    lines.push("Worth reviewing but lower risk:\n");
    const lowRows = low.map((issue) => [
      `${issue.filePath}:${issue.line}`,
      issue.description.substring(0, 60),
    ]);
    lines.push(formatTable(["Location", "Issue"], lowRows));
  }

  return lines.join("\n");
}

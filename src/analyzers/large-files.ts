import { scanFilesWithSize, type FileWithSize } from "../utils/file-scanner.js";
import { formatBytes, formatTable } from "../utils/formatter.js";
import type { LargeFileEntry } from "../types/analysis.js";

const CATEGORY_PATTERNS: Record<string, string[]> = {
  images: ["**/*.png", "**/*.jpg", "**/*.jpeg", "**/*.gif", "**/*.webp", "**/*.heic", "**/*.tiff", "**/*.bmp", "**/*.svg"],
  videos: ["**/*.mp4", "**/*.mov", "**/*.m4v", "**/*.avi"],
  fonts: ["**/*.ttf", "**/*.otf", "**/*.woff", "**/*.woff2"],
  json: ["**/*.json"],
  plists: ["**/*.plist"],
  xcassets: ["**/*.xcassets/**/*"],
  storyboards: ["**/*.storyboard", "**/*.xib"],
};

function categorize(path: string): string {
  const lower = path.toLowerCase();
  if (/\.(png|jpg|jpeg|gif|webp|heic|tiff|bmp|svg)$/.test(lower)) return "images";
  if (/\.(mp4|mov|m4v|avi)$/.test(lower)) return "videos";
  if (/\.(ttf|otf|woff|woff2)$/.test(lower)) return "fonts";
  if (/\.json$/.test(lower)) return "json";
  if (/\.plist$/.test(lower)) return "plists";
  if (/\.xcassets/.test(lower)) return "xcassets";
  if (/\.(storyboard|xib)$/.test(lower)) return "storyboards";
  return "other";
}

export interface LargeFilesOptions {
  projectPath: string;
  thresholdKB?: number;
  categories?: string[];
  checkXcassets?: boolean;
}

export async function analyzeLargeFiles(options: LargeFilesOptions): Promise<string> {
  const {
    projectPath,
    thresholdKB = 500,
    categories = ["all"],
    checkXcassets = true,
  } = options;

  const thresholdBytes = thresholdKB * 1024;

  // Determine patterns to scan
  let patterns: string[];
  if (categories.includes("all")) {
    patterns = ["**/*"];
  } else {
    patterns = categories.flatMap((c) => CATEGORY_PATTERNS[c] ?? []);
  }

  const allFiles = await scanFilesWithSize(projectPath, patterns, [
    "**/node_modules/**",
    "**/DerivedData/**",
    "**/.build/**",
    "**/.git/**",
  ]);

  const largeFiles = allFiles.filter((f) => f.sizeBytes >= thresholdBytes);

  if (largeFiles.length === 0) {
    return `No files larger than ${formatBytes(thresholdBytes)} found.`;
  }

  // Build entries
  const entries: LargeFileEntry[] = largeFiles.map((f) => ({
    path: f.relativePath,
    sizeBytes: f.sizeBytes,
    sizeFormatted: formatBytes(f.sizeBytes),
    category: categorize(f.relativePath),
  }));

  // Category summary
  const categoryTotals = new Map<string, { count: number; totalBytes: number }>();
  for (const entry of entries) {
    const existing = categoryTotals.get(entry.category) ?? { count: 0, totalBytes: 0 };
    existing.count++;
    existing.totalBytes += entry.sizeBytes;
    categoryTotals.set(entry.category, existing);
  }

  // Format output
  const lines: string[] = [];
  lines.push(`## Large Files (≥ ${formatBytes(thresholdBytes)})`);
  lines.push(`Found **${entries.length}** large files.\n`);

  // Category summary table
  lines.push("### By Category");
  const catRows = [...categoryTotals.entries()]
    .sort((a, b) => b[1].totalBytes - a[1].totalBytes)
    .map(([cat, info]) => [cat, String(info.count), formatBytes(info.totalBytes)]);
  lines.push(formatTable(["Category", "Count", "Total Size"], catRows));

  // Top files table
  lines.push("\n### Top Files");
  const topN = entries.slice(0, 30);
  const fileRows = topN.map((e) => [e.path, e.sizeFormatted, e.category]);
  lines.push(formatTable(["File", "Size", "Category"], fileRows));

  // Total
  const totalBytes = entries.reduce((sum, e) => sum + e.sizeBytes, 0);
  lines.push(`\n**Total:** ${formatBytes(totalBytes)} across ${entries.length} files`);

  return lines.join("\n");
}

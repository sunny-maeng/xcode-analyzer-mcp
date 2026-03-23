export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function formatMs(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}min`;
}

export function formatTree(
  node: { name: string; children?: { name: string; children?: unknown[] }[] },
  prefix = "",
  isLast = true,
): string {
  const connector = isLast ? "└── " : "├── ";
  const lines = [prefix + connector + node.name];

  if (node.children) {
    const childPrefix = prefix + (isLast ? "    " : "│   ");
    node.children.forEach((child, i) => {
      lines.push(
        formatTree(
          child as { name: string; children?: { name: string; children?: unknown[] }[] },
          childPrefix,
          i === node.children!.length - 1,
        ),
      );
    });
  }

  return lines.join("\n");
}

export function formatTable(
  headers: string[],
  rows: string[][],
): string {
  const colWidths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)),
  );

  const headerLine = headers.map((h, i) => h.padEnd(colWidths[i])).join(" | ");
  const separator = colWidths.map((w) => "-".repeat(w)).join("-|-");
  const dataLines = rows.map((row) =>
    row.map((cell, i) => (cell ?? "").padEnd(colWidths[i])).join(" | "),
  );

  return [headerLine, separator, ...dataLines].join("\n");
}

export interface ImportInfo {
  module: string;
  isTestable: boolean;
  subSymbol?: string;
  filePath: string;
  line: number;
}

export interface ModuleDependency {
  name: string;
  version?: string;
  url?: string;
  dependencies: string[];
}

export interface BuildTimeEntry {
  filePath: string;
  durationMs: number;
  module?: string;
}

export interface LargeFileEntry {
  path: string;
  sizeBytes: number;
  sizeFormatted: string;
  category: string;
}

export interface UnusedImportEntry {
  filePath: string;
  module: string;
  line: number;
  confidence: "high" | "medium" | "low";
  reason: string;
}

export interface DependencyNode {
  name: string;
  version?: string;
  url?: string;
  isTransitive: boolean;
  children: DependencyNode[];
}

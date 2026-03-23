# xcode-analyzer-mcp

MCP server for analyzing Xcode project dependencies, build times, and code health.

An AI-powered static analysis tool for iOS/macOS projects that works with Claude Code and other MCP-compatible clients.

## Features

- **Circular Dependency Detection** — Tarjan's SCC algorithm on module/file-level dependency graphs
- **Build Time Analysis** — Parse DerivedData build logs or estimate complexity heuristically
- **Import Dependency Graph** — Visualize module dependencies as Mermaid diagrams, DOT, or adjacency lists
- **Unused Import Detection** — Heuristic analysis with built-in symbol database for 20+ popular iOS frameworks
- **Dependency Tree** — SPM (Package.resolved) and CocoaPods (Podfile.lock) tree analysis
- **Large File Detection** — Find images, videos, fonts, and other resources impacting app size

## Quick Start

### With Claude Code

```bash
claude mcp add xcode-analyzer -- npx -y xcode-analyzer-mcp
```

### With Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "xcode-analyzer": {
      "command": "npx",
      "args": ["-y", "xcode-analyzer-mcp"]
    }
  }
}
```

### Manual Installation

```bash
npm install -g xcode-analyzer-mcp
```

## Available Tools

### `analyze_circular_dependencies`

Detect circular dependencies between modules or files.

| Parameter | Type | Description |
|-----------|------|-------------|
| `projectPath` | string (required) | Path to Xcode project root |
| `level` | "module" \| "file" | Analysis granularity (default: module) |
| `excludePatterns` | string[] | Glob patterns to exclude |

### `analyze_build_time`

Analyze build times from DerivedData logs or estimate via static analysis.

| Parameter | Type | Description |
|-----------|------|-------------|
| `projectPath` | string (required) | Path to Xcode project root |
| `derivedDataPath` | string | Custom DerivedData path |
| `scheme` | string | Xcode scheme name |
| `topN` | number | Top N slowest files (default: 20) |
| `thresholdMs` | number | Minimum duration filter |

### `analyze_import_graph`

Build and visualize module dependency graph from Swift imports.

| Parameter | Type | Description |
|-----------|------|-------------|
| `projectPath` | string (required) | Path to Xcode project root |
| `outputFormat` | "adjacency_list" \| "matrix" \| "mermaid" \| "dot" | Output format |
| `includeSystemFrameworks` | boolean | Include UIKit, Foundation, etc. |
| `excludePatterns` | string[] | Glob patterns to exclude |

### `detect_unused_imports`

Find potentially unused Swift import statements.

| Parameter | Type | Description |
|-----------|------|-------------|
| `projectPath` | string (required) | Path to Xcode project root |
| `targetPaths` | string[] | Specific paths to analyze |
| `confidence` | "high" \| "medium" \| "low" | Detection confidence filter |
| `excludePatterns` | string[] | Glob patterns to exclude |

### `analyze_dependency_tree`

Analyze SPM and CocoaPods dependency trees.

| Parameter | Type | Description |
|-----------|------|-------------|
| `projectPath` | string (required) | Path to Xcode project root |
| `packageManager` | "spm" \| "cocoapods" \| "auto" | Package manager (default: auto) |
| `showTransitive` | boolean | Show transitive deps (default: true) |

### `detect_large_files`

Find large files impacting app bundle size.

| Parameter | Type | Description |
|-----------|------|-------------|
| `projectPath` | string (required) | Path to Xcode project root |
| `thresholdKB` | number | Minimum size in KB (default: 500) |
| `categories` | string[] | File types: images, videos, fonts, json, plists, xcassets, storyboards, all |
| `checkXcassets` | boolean | Analyze .xcassets individually |

## Usage Examples

Once connected, ask Claude:

- "프로젝트에 순환 참조 있는지 확인해줘"
- "빌드 시간 가장 오래 걸리는 파일 top 10 보여줘"
- "의존성 그래프를 Mermaid 다이어그램으로 보여줘"
- "사용 안 하는 import 찾아줘"
- "SPM 의존성 트리 보여줘"
- "500KB 넘는 파일들 찾아줘"

## How It Works

This tool performs **static analysis only** — no compilation or Xcode required. It parses:

- `.swift` files for import statements
- `Package.swift` for SPM target dependencies
- `Package.resolved` for resolved SPM versions
- `Podfile.lock` for CocoaPods dependency tree
- `.pbxproj` for Xcode target/framework dependencies
- `.xcactivitylog` for build timing data (from DerivedData)

## Tech Stack

- TypeScript + Node.js 18+
- `@modelcontextprotocol/sdk` — MCP server framework
- `fast-glob` — File system scanning
- `zod` — Input validation
- **Zero runtime dependencies beyond these 3 packages**

## Development

```bash
git clone https://github.com/user/xcode-analyzer-mcp
cd xcode-analyzer-mcp
npm install
npm run dev    # Watch mode
npm run build  # Production build
npm test       # Run tests
```

## License

MIT

export interface PbxTarget {
  id: string;
  name: string;
  productName?: string;
  dependencies: string[];
  frameworkDependencies: string[];
  sourceFiles: string[];
}

export interface PbxprojData {
  targets: Map<string, PbxTarget>;
  fileReferences: Map<string, string>;
  groups: Map<string, string[]>;
}

export interface WorkspaceProject {
  path: string;
  name: string;
}

export interface XcodeProjectInfo {
  type: "xcworkspace" | "xcodeproj" | "spm" | "cocoapods";
  rootPath: string;
  projectPaths: string[];
  packageSwiftPath?: string;
  podfilePath?: string;
}

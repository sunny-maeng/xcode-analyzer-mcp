export interface PackageSwiftTarget {
  name: string;
  type: "regular" | "test" | "executable" | "plugin";
  dependencies: PackageSwiftDependency[];
  path?: string;
}

export interface PackageSwiftDependency {
  name: string;
  package?: string;
  isProduct: boolean;
}

export interface PackageSwiftProduct {
  name: string;
  type: "library" | "executable" | "plugin";
  libraryType?: "dynamic" | "static";
  targets: string[];
}

export interface PackageSwiftExternalDep {
  url: string;
  name?: string;
  version?: string;
  branch?: string;
  revision?: string;
}

export interface PackageSwiftData {
  targets: PackageSwiftTarget[];
  products: PackageSwiftProduct[];
  externalDependencies: PackageSwiftExternalDep[];
}

export interface PackageResolvedPin {
  identity: string;
  location: string;
  version?: string;
  revision?: string;
  branch?: string;
}

export interface PackageResolvedData {
  version: number;
  pins: PackageResolvedPin[];
}

import { readFile } from "node:fs/promises";
import type { PackageResolvedData, PackageResolvedPin } from "../types/spm.js";

/**
 * Parse Package.resolved (v2 and v3 formats).
 */
export async function parsePackageResolved(filePath: string): Promise<PackageResolvedData> {
  const source = await readFile(filePath, "utf-8");
  const json = JSON.parse(source);

  const version = json.version ?? json.object?.version ?? 2;

  if (version === 1) {
    return parseV1(json);
  }

  // v2 and v3 share similar structure
  return parseV2V3(json, version);
}

function parseV1(json: Record<string, unknown>): PackageResolvedData {
  const obj = json.object as Record<string, unknown>;
  const pins = (obj?.pins as Record<string, unknown>[]) ?? [];

  return {
    version: 1,
    pins: pins.map((pin) => {
      const state = pin.state as Record<string, string> | undefined;
      return {
        identity: (pin.package as string)?.toLowerCase() ?? "",
        location: pin.repositoryURL as string ?? "",
        version: state?.version,
        revision: state?.revision,
        branch: state?.branch,
      };
    }),
  };
}

function parseV2V3(json: Record<string, unknown>, version: number): PackageResolvedData {
  const pins = (json.pins as Record<string, unknown>[]) ?? [];

  return {
    version,
    pins: pins.map((pin) => {
      const state = pin.state as Record<string, string> | undefined;
      return {
        identity: pin.identity as string ?? "",
        location: pin.location as string ?? "",
        version: state?.version,
        revision: state?.revision,
        branch: state?.branch,
      };
    }),
  };
}

import { CONFIGURATION_URL, PREFERRED_MIRROR_SOURCE } from "../../settings";
import { fetchLibgen } from "./request";

export type MirrorType = "libgen-plus";

export interface Mirror {
  src: string;
  type: MirrorType;
}

export interface Config {
  latestVersion: string;
  mirrors: Mirror[];
}

function prioritizePreferredMirror(mirrors: Mirror[]): Mirror[] {
  const preferred = PREFERRED_MIRROR_SOURCE.replace(/\/+$/, "");
  const isPreferred = (mirror: Mirror) => mirror.src.replace(/\/+$/, "") === preferred;

  return [
    ...mirrors.filter((mirror) => isPreferred(mirror)),
    ...mirrors.filter((mirror) => !isPreferred(mirror)),
  ];
}

export async function fetchConfig(): Promise<Config> {
  try {
    const response = await fetch(CONFIGURATION_URL);
    const json = await response.json();
    const config = json as Record<string, unknown>;

    return {
      latestVersion: (config["latest_version"] as string) || "",
      mirrors: prioritizePreferredMirror((config["mirrors"] as Mirror[]) || []),
    };
  } catch {
    throw new Error("Error occurred while fetching configuration.");
  }
}

export async function findMirror(
  mirrors: Mirror[],
  onMirrorFail: (failedMirror: string) => void
): Promise<Mirror | undefined> {
  for (const mirror of mirrors) {
    try {
      const response = await fetchLibgen(mirror.src);
      if (!response.ok) {
        throw new Error(`Mirror returned HTTP ${response.status}`);
      }
      return mirror;
    } catch {
      onMirrorFail(mirror.src);
    }
  }
  return undefined;
}

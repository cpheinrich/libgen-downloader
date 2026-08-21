import type { Adapter } from "../api/adapters/adapter";
import type { Mirror } from "../api/data/config";
import type { Entry } from "../api/models/entry";

export interface BookRequest {
  query: string;
  title?: string;
  author?: string;
  sourceLine: string;
}

export interface RankedCandidate {
  entry: Entry;
  md5: string;
  score: number;
  reasons: string[];
  sourceKind?: "libgen" | "local";
  sourceSHA256?: string;
  originalFilename?: string;
}

export interface BookPaths {
  libraryRoot: string;
  bookDirectory: string;
  sourcePath: string;
  doclingDirectory: string;
  doclingJSONPath: string;
  doclingMarkdownPath: string;
  doclingAssetsDirectory: string;
  metadataPath: string;
  conversionPath: string;
  canonicalStem: string;
}

export type ConversionStatus = "converted" | "unavailable" | "failed";

export interface ConversionResult {
  status: ConversionStatus;
  converter?: "docling";
  message: string;
  doclingJSONPath?: string;
  doclingMarkdownPath?: string;
}

export interface LibgenSession {
  adapter: Adapter;
  mirror: Mirror;
}

export type IngestionStatus = "downloaded" | "skipped" | "failed";

export interface IngestionResult {
  request: BookRequest;
  status: IngestionStatus;
  message: string;
  selected?: RankedCandidate;
  paths?: BookPaths;
  conversion?: ConversionResult;
}

export interface IngestionOptions {
  libraryRoot?: string;
  pageCount?: number;
  finalistCount?: number;
  convert?: boolean;
  includeMarkdown?: boolean;
  session?: LibgenSession;
  onProgress?: (message: string) => void;
}

export interface LocalImportOptions {
  libraryRoot?: string;
  title?: string;
  author?: string;
  convert?: boolean;
  includeMarkdown?: boolean;
  onProgress?: (message: string) => void;
}

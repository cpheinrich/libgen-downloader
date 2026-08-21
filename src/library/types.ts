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
  assetsDirectory: string;
  sourcePath: string;
  markdownPath: string;
  doclingPath: string;
  metadataPath: string;
  conversionPath: string;
  canonicalStem: string;
}

export type ConversionStatus = "converted" | "unavailable" | "failed";
export type ConversionOutputFormat = "canonical" | "docling" | "both";

export interface ConversionResult {
  status: ConversionStatus;
  converter?: "copy" | "pandoc" | "docling";
  message: string;
  markdownPath?: string;
  doclingPath?: string;
  outputFormat?: ConversionOutputFormat;
  validation?: CanonicalValidation;
}

export interface CanonicalValidation {
  valid: boolean;
  words: number;
  headings: number;
  images: number;
  assets: number;
  issues: string[];
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
  outputFormat?: ConversionOutputFormat;
  session?: LibgenSession;
  onProgress?: (message: string) => void;
}

export interface LocalImportOptions {
  libraryRoot?: string;
  title?: string;
  author?: string;
  convert?: boolean;
  outputFormat?: ConversionOutputFormat;
  onProgress?: (message: string) => void;
}

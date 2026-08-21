import os from "node:os";
import path from "node:path";
import type { Entry } from "../api/models/entry";
import type { BookPaths } from "./types";

const MAX_AUTHOR_LENGTH = 64;
const MAX_TITLE_LENGTH = 112;

export function getLibraryRoot(override?: string): string {
  const configured = override || process.env.LIBGEN_LIBRARY_DIR;
  if (configured) {
    return path.resolve(configured.replace(/^~(?=$|\/)/, os.homedir()));
  }
  return path.join(os.homedir(), "libgen");
}

export function slugify(value: string, maximumLength = MAX_TITLE_LENGTH): string {
  const normalized = value
    .normalize("NFKD")
    .replaceAll(/\p{Mark}/gu, "")
    .toLowerCase()
    .replaceAll("&", " and ")
    .replaceAll(/[’']/g, "")
    .replaceAll(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replaceAll(/^-+|-+$/g, "")
    .replaceAll(/-+/g, "-")
    .slice(0, maximumLength)
    .replaceAll(/-+$/g, "");

  return normalized || "unknown";
}

export function getPrimaryAuthor(authors: string): string {
  const [primaryAuthor] = authors.split(/,|;/);
  return primaryAuthor?.trim() || "unknown-author";
}

export function getCanonicalStem(entry: Pick<Entry, "authors" | "title">): string {
  const author = slugify(getPrimaryAuthor(entry.authors), MAX_AUTHOR_LENGTH);
  const title = slugify(entry.title, MAX_TITLE_LENGTH);
  return `${author}_${title}`;
}

export function normalizeExtension(extension: string): string {
  const normalized = extension.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
  return normalized || "bin";
}

export function getEntryMD5(entry: Pick<Entry, "mirror">): string | undefined {
  try {
    const url = new URL(entry.mirror, "https://libgen.invalid/");
    return url.searchParams.get("md5") || undefined;
  } catch {
    return undefined;
  }
}

export function createBookPaths(entry: Entry, libraryRootOverride?: string): BookPaths {
  const libraryRoot = getLibraryRoot(libraryRootOverride);
  const canonicalStem = getCanonicalStem(entry);
  const bookDirectory = path.join(libraryRoot, canonicalStem);
  const extension = normalizeExtension(entry.extension);

  return {
    libraryRoot,
    canonicalStem,
    bookDirectory,
    assetsDirectory: path.join(bookDirectory, "assets"),
    sourcePath: path.join(bookDirectory, `source.${extension}`),
    markdownPath: path.join(bookDirectory, "book.md"),
    metadataPath: path.join(bookDirectory, "metadata.json"),
    conversionPath: path.join(bookDirectory, "conversion.json"),
  };
}

export function createMD5BookPaths(
  md5: string,
  extension: string,
  libraryRootOverride?: string
): BookPaths {
  return createBookPaths(
    {
      id: md5,
      authors: "unknown-author",
      title: md5,
      publisher: "",
      year: "",
      pages: "",
      language: "",
      size: "",
      extension,
      mirror: `/ads.php?md5=${md5}`,
    },
    libraryRootOverride
  );
}

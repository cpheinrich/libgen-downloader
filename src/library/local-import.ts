import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Entry } from "../api/models/entry";
import type { CommandRunner } from "./converter";
import { convertBook, runCommand } from "./converter";
import { readEpubPackage } from "./epub";
import { writeBookRecords } from "./metadata";
import { createBookPaths, getLibraryRoot, normalizeExtension } from "./naming";
import type {
  ConversionResult,
  IngestionResult,
  LocalImportOptions,
  RankedCandidate,
} from "./types";

interface LocalImportRuntimeOptions extends LocalImportOptions {
  runner?: CommandRunner;
}

interface FilenameMetadata {
  title: string;
  author?: string;
}

function restoreCommaSeparatedAuthor(value: string): string {
  const parts = value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length !== 2) {
    return value.trim();
  }
  return `${parts[1]} ${parts[0]}`;
}

export function inferFilenameMetadata(sourcePath: string): FilenameMetadata {
  const stem = path.basename(sourcePath, path.extname(sourcePath)).trim();
  const byMatch = stem.match(/^(.+?)\s+by\s+(.+)$/i);
  if (byMatch?.[1] && byMatch[2]) {
    return { title: byMatch[1].trim(), author: byMatch[2].trim() };
  }

  const dashMatch = stem.match(/^(.+?)\s+-\s+(.+)$/);
  if (dashMatch?.[1] && dashMatch[2]) {
    return {
      title: dashMatch[2].trim(),
      author: restoreCommaSeparatedAuthor(dashMatch[1]),
    };
  }
  return { title: stem };
}

async function getChecksums(sourcePath: string): Promise<{ md5: string; sha256: string }> {
  const contents = await fs.promises.readFile(sourcePath);
  return {
    md5: createHash("md5").update(contents).digest("hex"),
    sha256: createHash("sha256").update(contents).digest("hex"),
  };
}

async function createLocalEntry(sourcePath: string, options: LocalImportOptions): Promise<Entry> {
  const filename = inferFilenameMetadata(sourcePath);
  const extension = normalizeExtension(path.extname(sourcePath).slice(1));
  let embedded: Awaited<ReturnType<typeof readEpubPackage>> = {};
  if (extension === "epub") {
    embedded = await readEpubPackage(sourcePath);
  }
  const stat = await fs.promises.stat(sourcePath);
  let inferredTitle = embedded.title || filename.title;
  if (filename.author) {
    inferredTitle = filename.title;
  }

  return {
    id: path.basename(sourcePath),
    title: options.title || inferredTitle || "Unknown title",
    authors: options.author || filename.author || embedded.authors || "unknown-author",
    publisher: embedded.publisher || "",
    year: "",
    pages: "",
    language: embedded.language || "",
    size: String(stat.size),
    extension,
    mirror: "",
  };
}

export async function importLocalBook(
  sourcePathInput: string,
  options: LocalImportRuntimeOptions = {}
): Promise<IngestionResult> {
  const sourcePath = path.resolve(sourcePathInput.replace(/^~(?=$|\/)/, process.env.HOME || ""));
  const stat = await fs.promises.stat(sourcePath);
  if (!stat.isFile()) {
    throw new Error(`Local import source is not a file: ${sourcePath}`);
  }

  const entry = await createLocalEntry(sourcePath, options);
  const checksums = await getChecksums(sourcePath);
  const candidate: RankedCandidate = {
    entry,
    md5: checksums.md5,
    score: 0,
    reasons: ["locally owned source"],
    sourceKind: "local",
    sourceSHA256: checksums.sha256,
    originalFilename: path.basename(sourcePath),
  };
  const request = {
    query: entry.title,
    title: entry.title,
    author: entry.authors,
    sourceLine: path.basename(sourcePath),
  };
  const libraryRoot = getLibraryRoot(options.libraryRoot);
  const finalPaths = createBookPaths(entry, libraryRoot);
  if (fs.existsSync(finalPaths.bookDirectory)) {
    return {
      request,
      status: "skipped",
      message: `Canonical directory already exists; left it untouched at ${finalPaths.bookDirectory}`,
      selected: candidate,
      paths: finalPaths,
    };
  }

  await fs.promises.mkdir(libraryRoot, { recursive: true });
  const stagingRoot = await fs.promises.mkdtemp(path.join(libraryRoot, ".staging-import-"));
  const stagingPaths = createBookPaths(entry, stagingRoot);
  try {
    options.onProgress?.(`Copying ${path.basename(sourcePath)} without modifying the original...`);
    await fs.promises.mkdir(stagingPaths.bookDirectory, { recursive: true });
    await fs.promises.copyFile(sourcePath, stagingPaths.sourcePath);

    let conversion: ConversionResult = {
      status: "unavailable",
      message: "Document conversion was disabled; the standardized source was retained.",
    };
    if (options.convert !== false) {
      let outputDescription = "native Docling JSON";
      if (options.includeMarkdown) {
        outputDescription += " and Markdown";
      }
      options.onProgress?.(`Converting the local source to ${outputDescription}...`);
      conversion = await convertBook(
        stagingPaths,
        candidate,
        options.runner || runCommand,
        options.includeMarkdown
      );
      if (conversion.status === "failed") {
        throw new Error(conversion.message);
      }
    }

    const recordedConversion = { ...conversion };
    if (recordedConversion.doclingJSONPath) {
      recordedConversion.doclingJSONPath = "docling/source.json";
    }
    if (recordedConversion.doclingMarkdownPath) {
      recordedConversion.doclingMarkdownPath = "docling/source.md";
    }
    await writeBookRecords({
      paths: stagingPaths,
      request,
      selected: candidate,
      conversion: recordedConversion,
    });
    await fs.promises.rename(stagingPaths.bookDirectory, finalPaths.bookDirectory);
    await fs.promises.rm(stagingRoot, { recursive: true, force: true });

    const finalConversion = { ...conversion };
    if (conversion.doclingJSONPath) {
      finalConversion.doclingJSONPath = finalPaths.doclingJSONPath;
    }
    if (conversion.doclingMarkdownPath) {
      finalConversion.doclingMarkdownPath = finalPaths.doclingMarkdownPath;
    }

    return {
      request,
      status: "downloaded",
      message: `Imported the local source to ${finalPaths.bookDirectory}`,
      selected: candidate,
      paths: finalPaths,
      conversion: finalConversion,
    };
  } catch (error) {
    await fs.promises.rm(stagingRoot, { recursive: true, force: true });
    throw error;
  }
}

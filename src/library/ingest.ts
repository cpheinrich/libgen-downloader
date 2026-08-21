import fs from "node:fs";
import path from "node:path";
import { getAdapter } from "../api/adapters";
import { fetchConfig, findMirror } from "../api/data/config";
import { getDocument } from "../api/data/document";
import { downloadURLToFile } from "../api/data/resumable-download";
import { fetchLibgen } from "../api/data/request";
import { SEARCH_PAGE_SIZE } from "../settings";
import { rankCandidates } from "./candidates";
import { canConvertWithDocling, convertBook } from "./converter";
import { writeBookRecords } from "./metadata";
import { createBookPaths, getLibraryRoot } from "./naming";
import type {
  BookPaths,
  BookRequest,
  ConversionResult,
  IngestionOptions,
  IngestionResult,
  LibgenSession,
  RankedCandidate,
} from "./types";

const DEFAULT_PAGE_COUNT = 2;
const DEFAULT_FINALIST_COUNT = 3;

function report(options: IngestionOptions, message: string): void {
  options.onProgress?.(message);
}

export async function createLibgenSession(
  onMirrorFail: (failedMirror: string) => void = () => {}
): Promise<LibgenSession> {
  const config = await fetchConfig();
  const mirror = await findMirror(config.mirrors, onMirrorFail);
  if (!mirror) {
    throw new Error("No reachable LibGen mirror was found.");
  }

  return { mirror, adapter: getAdapter(mirror.src, mirror.type) };
}

export async function searchBookCandidates(
  session: LibgenSession,
  request: BookRequest,
  pageCount = DEFAULT_PAGE_COUNT
): Promise<RankedCandidate[]> {
  const entries = [];
  let searchQuery = request.query;
  if (request.author) {
    searchQuery = `${request.query} ${request.author}`;
  }
  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
    const searchURL = session.adapter.getSearchURL(searchQuery, pageNumber, SEARCH_PAGE_SIZE);
    const result = await getDocument(searchURL);
    const connectionError = session.adapter.detectConnectionError(result.document);
    if (connectionError) {
      throw new Error(connectionError);
    }

    const pageEntries = session.adapter.parseEntries(result.document) || [];
    if (pageEntries.length === 0) {
      break;
    }
    entries.push(...pageEntries);
  }

  return rankCandidates(entries, request).filter((candidate) => candidate.score >= 40);
}

async function validateDownloadedSource(candidate: RankedCandidate, sourcePath: string) {
  const file = await fs.promises.open(sourcePath, "r");
  try {
    const buffer = Buffer.alloc(8);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead === 0) {
      throw new Error("The downloaded source is empty.");
    }

    const signature = buffer.subarray(0, bytesRead).toString("latin1");
    const extension = candidate.entry.extension.toLowerCase();
    if (extension === "pdf" && !signature.startsWith("%PDF-")) {
      throw new Error("The selected PDF candidate did not contain a PDF file.");
    }
    if (extension === "epub" && !signature.startsWith("PK")) {
      throw new Error("The selected EPUB candidate was not a valid EPUB container.");
    }
  } finally {
    await file.close();
  }
}

async function downloadCandidate(
  session: LibgenSession,
  candidate: RankedCandidate,
  paths: BookPaths,
  options: IngestionOptions
): Promise<void> {
  const detailURL = session.adapter.getPageURL(candidate.entry.mirror);
  const detailResult = await getDocument(detailURL);
  const downloadURL = session.adapter.getMainDownloadURLFromDocument(detailResult.document);
  if (!downloadURL) {
    throw new Error("The candidate detail page did not contain a download URL.");
  }

  report(options, `Downloading ${candidate.entry.extension.toUpperCase()} candidate...`);
  let lastReportedPercentage = 0;
  let lastReportedMegabytes = 0;
  try {
    await downloadURLToFile({
      url: downloadURL,
      destinationPath: paths.sourcePath,
      fetcher: fetchLibgen,
      onRetry(message) {
        report(options, message);
      },
      onProgress(downloadedBytes, totalBytes) {
        if (totalBytes) {
          const percentage = Math.min(100, Math.floor((downloadedBytes / totalBytes) * 100));
          const reportablePercentage = Math.floor(percentage / 10) * 10;
          if (reportablePercentage >= lastReportedPercentage + 10) {
            lastReportedPercentage = reportablePercentage;
            report(options, `Downloaded ${reportablePercentage}% of the candidate...`);
          }
          return;
        }

        const downloadedMegabytes = Math.floor(downloadedBytes / (5 * 1024 * 1024)) * 5;
        if (downloadedMegabytes >= lastReportedMegabytes + 5) {
          lastReportedMegabytes = downloadedMegabytes;
          report(options, `Downloaded ${downloadedMegabytes} MB of the candidate...`);
        }
      },
    });
  } catch (error) {
    let reason = String(error);
    if (error instanceof Error) {
      reason = error.message;
    }
    throw new Error(
      `The LibGen search mirror is online, but its shared file-download host failed: ${reason}`,
      { cause: error }
    );
  }
  await validateDownloadedSource(candidate, paths.sourcePath);
}

function sourceOnlyConversion(): ConversionResult {
  return {
    status: "unavailable",
    message: "Document conversion was disabled; the standardized source was retained.",
  };
}

async function finalizeStagingDirectory(
  stagingPaths: BookPaths,
  finalPaths: BookPaths,
  stagingRoot: string
): Promise<void> {
  if (fs.existsSync(finalPaths.bookDirectory)) {
    throw new Error(`The canonical book directory already exists: ${finalPaths.bookDirectory}`);
  }
  await fs.promises.rename(stagingPaths.bookDirectory, finalPaths.bookDirectory);
  await fs.promises.rm(stagingRoot, { recursive: true, force: true });
}

export async function ingestBestBook(
  request: BookRequest,
  options: IngestionOptions = {}
): Promise<IngestionResult> {
  const libraryRoot = getLibraryRoot(options.libraryRoot);
  await fs.promises.mkdir(libraryRoot, { recursive: true });

  const session = options.session || (await createLibgenSession());
  report(options, `Searching ${session.mirror.src} for "${request.query}"...`);
  let candidates = await searchBookCandidates(
    session,
    request,
    options.pageCount || DEFAULT_PAGE_COUNT
  );
  if (options.convert !== false) {
    candidates = candidates.filter((candidate) => canConvertWithDocling(candidate.entry.extension));
  }
  if (candidates.length === 0) {
    let message = "No sufficiently close, downloadable candidates were found.";
    if (options.convert !== false) {
      message = "No sufficiently close candidates support native Docling output.";
    }
    return {
      request,
      status: "failed",
      message,
    };
  }

  const finalistCount = options.finalistCount || DEFAULT_FINALIST_COUNT;
  const finalists = candidates.slice(0, finalistCount);
  let lastError = "All finalist candidates failed.";

  for (const [index, candidate] of finalists.entries()) {
    const finalPaths = createBookPaths(candidate.entry, libraryRoot);
    if (fs.existsSync(finalPaths.bookDirectory)) {
      return {
        request,
        status: "skipped",
        message: `Canonical directory already exists; left it untouched at ${finalPaths.bookDirectory}`,
        selected: candidate,
        paths: finalPaths,
      };
    }

    const stagingRoot = await fs.promises.mkdtemp(path.join(libraryRoot, ".staging-"));
    const stagingPaths = createBookPaths(candidate.entry, stagingRoot);
    await fs.promises.mkdir(stagingPaths.bookDirectory, { recursive: true });

    try {
      report(
        options,
        `Evaluating candidate ${index + 1}/${finalists.length}: ${candidate.reasons.join(", ")}`
      );
      await downloadCandidate(session, candidate, stagingPaths, options);

      let conversion = sourceOnlyConversion();
      if (options.convert !== false) {
        let outputDescription = "native Docling JSON";
        if (options.includeMarkdown) {
          outputDescription += " and Markdown";
        }
        report(options, `Converting the selected source to ${outputDescription}...`);
        conversion = await convertBook(stagingPaths, candidate, undefined, options.includeMarkdown);
      }

      if (conversion.status === "failed") {
        lastError = conversion.message;
        await fs.promises.rm(stagingRoot, { recursive: true, force: true });
        continue;
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
      await finalizeStagingDirectory(stagingPaths, finalPaths, stagingRoot);

      const finalConversion = { ...conversion };
      if (finalConversion.doclingJSONPath) {
        finalConversion.doclingJSONPath = finalPaths.doclingJSONPath;
      }
      if (finalConversion.doclingMarkdownPath) {
        finalConversion.doclingMarkdownPath = finalPaths.doclingMarkdownPath;
      }
      let message = `Saved the best candidate to ${finalPaths.bookDirectory}`;
      if (conversion.status !== "converted") {
        message += ` (${conversion.message})`;
      }
      return {
        request,
        status: "downloaded",
        message,
        selected: candidate,
        paths: finalPaths,
        conversion: finalConversion,
      };
    } catch (error) {
      lastError = String(error);
      if (error instanceof Error) {
        lastError = error.message;
      }
      await fs.promises.rm(stagingRoot, { recursive: true, force: true });
    }
  }

  return { request, status: "failed", message: lastError };
}

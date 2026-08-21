import path from "node:path";
import fs from "node:fs";
import { downloadFile, getResponseFilename } from "../api/data/download";
import type { Entry } from "../api/models/entry";
import { writeBookRecords } from "./metadata";
import { createBookPaths, createMD5BookPaths, getEntryMD5, normalizeExtension } from "./naming";
import type { BookPaths, RankedCandidate } from "./types";

interface ProgressCallbacks {
  onStart: (filename: string, total: number) => void;
  onData: (filename: string, chunk: Buffer, total: number) => void;
}

async function saveSource(
  entry: Entry,
  md5: string,
  paths: BookPaths,
  downloadStream: Response,
  callbacks: ProgressCallbacks
): Promise<BookPaths> {
  await fs.promises.mkdir(paths.assetsDirectory, { recursive: true });
  await downloadFile({
    downloadStream,
    destinationPath: paths.sourcePath,
    filename: path.basename(paths.sourcePath),
    ...callbacks,
  });

  const selected: RankedCandidate = {
    entry,
    md5,
    score: 0,
    reasons: ["manually selected copy"],
  };
  await writeBookRecords({
    paths,
    request: { query: entry.title, title: entry.title, sourceLine: entry.title },
    selected,
    conversion: {
      status: "unavailable",
      message: "Manual copy retained. Use --best or --list for automatic Markdown conversion.",
    },
  });
  return paths;
}

export async function saveEntrySource(
  entry: Entry,
  downloadStream: Response,
  callbacks: ProgressCallbacks
): Promise<BookPaths> {
  const md5 = getEntryMD5(entry) || entry.id;
  return saveSource(entry, md5, createBookPaths(entry), downloadStream, callbacks);
}

export async function saveMD5Source(
  md5: string,
  downloadStream: Response,
  callbacks: ProgressCallbacks
): Promise<BookPaths> {
  const responseFilename = getResponseFilename(downloadStream) || "source.bin";
  const extension = normalizeExtension(path.extname(responseFilename).slice(1));
  const paths = createMD5BookPaths(md5, extension);
  const entry: Entry = {
    id: md5,
    authors: "unknown-author",
    title: md5,
    publisher: "",
    year: "",
    pages: "",
    language: "",
    size: downloadStream.headers.get("content-length") || "",
    extension,
    mirror: `/ads.php?md5=${md5}`,
  };
  return saveSource(entry, md5, paths, downloadStream, callbacks);
}

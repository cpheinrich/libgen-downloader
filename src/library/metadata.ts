import fs from "node:fs";
import type { Entry } from "../api/models/entry";
import type { BookPaths, BookRequest, ConversionResult, RankedCandidate } from "./types";

interface MetadataArguments {
  paths: BookPaths;
  request: BookRequest;
  selected: RankedCandidate;
  conversion: ConversionResult;
}

export async function writeBookRecords({
  paths,
  request,
  selected,
  conversion,
}: MetadataArguments): Promise<void> {
  const metadata = {
    schemaVersion: 1,
    title: selected.entry.title,
    authors: selected.entry.authors,
    publisher: selected.entry.publisher,
    year: selected.entry.year,
    pages: selected.entry.pages,
    language: selected.entry.language,
    sourceFormat: selected.entry.extension.toLowerCase(),
    sourceFile: "source." + selected.entry.extension.toLowerCase(),
    libgenMD5: selected.md5,
    libgenMirrorPath: selected.entry.mirror,
    requestedAs: request.sourceLine,
    selection: {
      score: selected.score,
      reasons: selected.reasons,
    },
    ingestedAt: new Date().toISOString(),
  };

  await fs.promises.writeFile(paths.metadataPath, `${JSON.stringify(metadata, undefined, 2)}\n`);
  await fs.promises.writeFile(
    paths.conversionPath,
    `${JSON.stringify(conversion, undefined, 2)}\n`
  );
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

export function createMarkdownFrontmatter(entry: Entry, md5: string): string {
  return [
    "---",
    `title: ${yamlString(entry.title)}`,
    `authors: ${yamlString(entry.authors)}`,
    `publisher: ${yamlString(entry.publisher)}`,
    `year: ${yamlString(entry.year)}`,
    `language: ${yamlString(entry.language)}`,
    `libgen_md5: ${yamlString(md5)}`,
    `source_format: ${yamlString(entry.extension.toLowerCase())}`,
    "---",
    "",
  ].join("\n");
}

export async function addMarkdownFrontmatter(
  markdownPath: string,
  entry: Entry,
  md5: string
): Promise<void> {
  const markdown = await fs.promises.readFile(markdownPath, "utf8");
  if (markdown.includes(`libgen_md5: ${yamlString(md5)}`)) {
    return;
  }

  await fs.promises.writeFile(markdownPath, createMarkdownFrontmatter(entry, md5) + markdown);
}

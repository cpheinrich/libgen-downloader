import fs from "node:fs";
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
  const sourceKind = selected.sourceKind || "libgen";
  let libgenMD5: string | undefined;
  let libgenMirrorPath: string | undefined;
  if (sourceKind === "libgen") {
    libgenMD5 = selected.md5;
    libgenMirrorPath = selected.entry.mirror;
  }
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
    source: {
      kind: sourceKind,
      file: "source." + selected.entry.extension.toLowerCase(),
      format: selected.entry.extension.toLowerCase(),
      md5: selected.md5,
      sha256: selected.sourceSHA256,
      originalFilename: selected.originalFilename,
      libgenMirrorPath,
    },
    libgenMD5,
    libgenMirrorPath,
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

export function createMarkdownFrontmatter(candidate: RankedCandidate): string {
  const lines = [
    "---",
    `title: ${yamlString(candidate.entry.title)}`,
    `authors: ${yamlString(candidate.entry.authors)}`,
    `publisher: ${yamlString(candidate.entry.publisher)}`,
    `year: ${yamlString(candidate.entry.year)}`,
    `language: ${yamlString(candidate.entry.language)}`,
    `source_kind: ${yamlString(candidate.sourceKind || "libgen")}`,
    `source_format: ${yamlString(candidate.entry.extension.toLowerCase())}`,
  ];
  if (candidate.sourceKind === "local") {
    lines.push(`source_md5: ${yamlString(candidate.md5)}`);
    if (candidate.sourceSHA256) {
      lines.push(`source_sha256: ${yamlString(candidate.sourceSHA256)}`);
    }
  } else {
    lines.push(`libgen_md5: ${yamlString(candidate.md5)}`);
  }
  lines.push("---", "");
  return lines.join("\n");
}

export async function addMarkdownFrontmatter(
  markdownPath: string,
  candidate: RankedCandidate
): Promise<void> {
  const markdown = await fs.promises.readFile(markdownPath, "utf8");
  let checksumLine = `libgen_md5: ${yamlString(candidate.md5)}`;
  if (candidate.sourceKind === "local") {
    checksumLine = `source_md5: ${yamlString(candidate.md5)}`;
  }
  if (markdown.includes(checksumLine)) {
    return;
  }

  await fs.promises.writeFile(markdownPath, createMarkdownFrontmatter(candidate) + markdown);
}

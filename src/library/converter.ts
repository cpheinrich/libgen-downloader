import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { extractSupplementalEpubAssets, type SupplementalAsset } from "./epub";
import { normalizeBookMarkdown } from "./markdown";
import { addMarkdownFrontmatter } from "./metadata";
import type { BookPaths, ConversionOutputFormat, ConversionResult, RankedCandidate } from "./types";

const CONVERSION_TIMEOUT_MS = 15 * 60 * 1000;
const DOCLING_INPUT_EXTENSIONS = new Set([
  "adoc",
  "asciidoc",
  "bmp",
  "csv",
  "docx",
  "htm",
  "html",
  "jpeg",
  "jpg",
  "md",
  "pdf",
  "png",
  "pptx",
  "tif",
  "tiff",
  "webp",
  "xlsx",
  "xml",
]);

export function canConvertWithDocling(extension: string): boolean {
  return DOCLING_INPUT_EXTENSIONS.has(extension.toLowerCase());
}

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (
  command: string,
  arguments_: string[],
  workingDirectory: string
) => Promise<CommandResult>;

export const runCommand: CommandRunner = (command, arguments_, workingDirectory) =>
  new Promise((resolve) => {
    execFile(
      command,
      arguments_,
      {
        cwd: workingDirectory,
        maxBuffer: 10 * 1024 * 1024,
        timeout: CONVERSION_TIMEOUT_MS,
      },
      (error, stdout, stderr) => {
        let exitCode = 0;
        if (error) {
          exitCode = 1;
          if (typeof error.code === "number") {
            exitCode = error.code;
          }
        }
        resolve({ exitCode, stdout, stderr });
      }
    );
  });

async function commandIsAvailable(
  command: string,
  runner: CommandRunner,
  workingDirectory: string
): Promise<boolean> {
  const result = await runner(command, ["--version"], workingDirectory);
  return result.exitCode === 0;
}

async function validateMarkdown(markdownPath: string): Promise<boolean> {
  try {
    const contents = await fs.promises.readFile(markdownPath, "utf8");
    return contents.trim().length >= 20;
  } catch {
    return false;
  }
}

async function normalizeDoclingOutput(
  paths: BookPaths,
  outputFormat: ConversionOutputFormat
): Promise<void> {
  const generatedMarkdown = path.join(paths.bookDirectory, "source.md");
  if (
    outputFormat !== "docling" &&
    generatedMarkdown !== paths.markdownPath &&
    fs.existsSync(generatedMarkdown)
  ) {
    await fs.promises.rename(generatedMarkdown, paths.markdownPath);
  }

  const generatedDocling = path.join(paths.bookDirectory, "source.json");
  if (
    outputFormat !== "canonical" &&
    generatedDocling !== paths.doclingPath &&
    fs.existsSync(generatedDocling)
  ) {
    await fs.promises.rename(generatedDocling, paths.doclingPath);
  }

  const generatedAssets = path.join(paths.bookDirectory, "source_artifacts");
  if (!fs.existsSync(generatedAssets)) {
    return;
  }

  await fs.promises.mkdir(paths.assetsDirectory, { recursive: true });
  await fs.promises.cp(generatedAssets, paths.assetsDirectory, { recursive: true });
  await fs.promises.rm(generatedAssets, { recursive: true, force: true });

  if (fs.existsSync(paths.markdownPath)) {
    const markdown = await fs.promises.readFile(paths.markdownPath, "utf8");
    await fs.promises.writeFile(
      paths.markdownPath,
      markdown.replaceAll("source_artifacts/", "assets/")
    );
  }
  if (fs.existsSync(paths.doclingPath)) {
    const document = await fs.promises.readFile(paths.doclingPath, "utf8");
    await fs.promises.writeFile(
      paths.doclingPath,
      document.replaceAll("source_artifacts/", "assets/")
    );
  }
}

async function validateDoclingDocument(doclingPath: string): Promise<boolean> {
  try {
    const document = JSON.parse(await fs.promises.readFile(doclingPath, "utf8"));
    return document !== null && typeof document === "object";
  } catch {
    return false;
  }
}

async function convertTextSource(
  paths: BookPaths,
  candidate: RankedCandidate
): Promise<ConversionResult> {
  await fs.promises.copyFile(paths.sourcePath, paths.markdownPath);
  await normalizeBookMarkdown(paths.markdownPath, candidate.entry.title);
  await addMarkdownFrontmatter(paths.markdownPath, candidate);
  return {
    status: "converted",
    converter: "copy",
    message: "Copied the textual source into canonical Markdown.",
    markdownPath: paths.markdownPath,
  };
}

async function convertWithPandoc(
  paths: BookPaths,
  candidate: RankedCandidate,
  runner: CommandRunner
): Promise<ConversionResult> {
  if (!(await commandIsAvailable("pandoc", runner, paths.bookDirectory))) {
    return {
      status: "unavailable",
      converter: "pandoc",
      message: "Pandoc is not installed; the original source was retained for later conversion.",
    };
  }

  const result = await runner(
    "pandoc",
    [
      path.basename(paths.sourcePath),
      "--to=gfm-raw_html+tex_math_dollars",
      "--wrap=none",
      "--extract-media=assets",
      `--output=${path.basename(paths.markdownPath)}`,
    ],
    paths.bookDirectory
  );

  if (result.exitCode !== 0 || !(await validateMarkdown(paths.markdownPath))) {
    return {
      status: "failed",
      converter: "pandoc",
      message: result.stderr.trim() || "Pandoc did not produce usable Markdown.",
    };
  }

  let supplementalAssets: SupplementalAsset[] = [];
  if (candidate.entry.extension.toLowerCase() === "epub") {
    supplementalAssets = await extractSupplementalEpubAssets(paths);
  }
  await normalizeBookMarkdown(paths.markdownPath, candidate.entry.title, supplementalAssets);
  await addMarkdownFrontmatter(paths.markdownPath, candidate);
  return {
    status: "converted",
    converter: "pandoc",
    message: "Converted the structured ebook with Pandoc.",
    markdownPath: paths.markdownPath,
  };
}

async function convertWithDocling(
  paths: BookPaths,
  candidate: RankedCandidate,
  runner: CommandRunner,
  outputFormat: ConversionOutputFormat
): Promise<ConversionResult> {
  if (!(await commandIsAvailable("docling", runner, paths.bookDirectory))) {
    return {
      status: "unavailable",
      converter: "docling",
      outputFormat,
      message: "Docling is not installed; the original source was retained for later conversion.",
    };
  }

  const requestedOutputs = [];
  if (outputFormat !== "docling") {
    requestedOutputs.push("--to=md");
  }
  if (outputFormat !== "canonical") {
    requestedOutputs.push("--to=json");
  }
  const arguments_ = [
    path.basename(paths.sourcePath),
    ...requestedOutputs,
    "--output=.",
    "--image-export-mode=referenced",
    "--enrich-formula",
  ];
  let result = await runner("docling", arguments_, paths.bookDirectory);

  if (result.exitCode !== 0) {
    result = await runner(
      "docling",
      [
        path.basename(paths.sourcePath),
        ...requestedOutputs,
        "--output=.",
        "--image-export-mode=referenced",
      ],
      paths.bookDirectory
    );
  }

  if (result.exitCode === 0) {
    await normalizeDoclingOutput(paths, outputFormat);
  }

  const markdownIsValid =
    outputFormat === "docling" || (await validateMarkdown(paths.markdownPath));
  const doclingIsValid =
    outputFormat === "canonical" || (await validateDoclingDocument(paths.doclingPath));
  if (result.exitCode !== 0 || !markdownIsValid || !doclingIsValid) {
    return {
      status: "failed",
      converter: "docling",
      outputFormat,
      message: result.stderr.trim() || "Docling did not produce the requested output.",
    };
  }

  if (outputFormat !== "docling") {
    await normalizeBookMarkdown(paths.markdownPath, candidate.entry.title);
    await addMarkdownFrontmatter(paths.markdownPath, candidate);
  }
  let message = "Converted the document to canonical Markdown with Docling.";
  if (outputFormat === "docling") {
    message = "Converted the document to native DoclingDocument JSON.";
  } else if (outputFormat === "both") {
    message = "Converted the document to canonical Markdown and native DoclingDocument JSON.";
  }
  const conversion: ConversionResult = {
    status: "converted",
    converter: "docling",
    outputFormat,
    message,
  };
  if (outputFormat !== "docling") {
    conversion.markdownPath = paths.markdownPath;
  }
  if (outputFormat !== "canonical") {
    conversion.doclingPath = paths.doclingPath;
  }
  return conversion;
}

export async function convertBook(
  paths: BookPaths,
  candidate: RankedCandidate,
  runner: CommandRunner = runCommand,
  outputFormat: ConversionOutputFormat = "canonical"
): Promise<ConversionResult> {
  await fs.promises.mkdir(paths.assetsDirectory, { recursive: true });
  const extension = candidate.entry.extension.toLowerCase();

  if (outputFormat !== "canonical") {
    if (!canConvertWithDocling(extension)) {
      return {
        status: "failed",
        converter: "docling",
        outputFormat,
        message: `Docling does not support native conversion from .${extension}; try --format canonical or select a PDF copy.`,
      };
    }
    return convertWithDocling(paths, candidate, runner, outputFormat);
  }

  if (["md", "markdown", "txt"].includes(extension)) {
    return convertTextSource(paths, candidate);
  }
  if (extension === "pdf") {
    return convertWithDocling(paths, candidate, runner, outputFormat);
  }
  if (["epub", "docx", "html", "htm", "mobi", "azw3", "fb2", "rtf", "odt"].includes(extension)) {
    return convertWithPandoc(paths, candidate, runner);
  }

  return {
    status: "unavailable",
    message: `No Markdown converter is configured for .${extension} files.`,
  };
}

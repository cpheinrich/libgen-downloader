import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { BookPaths, ConversionResult, RankedCandidate } from "./types";

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

async function validateDoclingDocument(doclingPath: string): Promise<boolean> {
  try {
    const document = JSON.parse(await fs.promises.readFile(doclingPath, "utf8"));
    return document?.schema_name === "DoclingDocument";
  } catch {
    return false;
  }
}

async function validateOptionalMarkdown(paths: BookPaths, includeMarkdown: boolean) {
  if (!includeMarkdown) {
    return true;
  }
  try {
    const markdown = await fs.promises.readFile(paths.doclingMarkdownPath, "utf8");
    return markdown.trim().length > 0;
  } catch {
    return false;
  }
}

function getDoclingArguments(paths: BookPaths, includeMarkdown: boolean, enrich: boolean) {
  const arguments_ = [
    path.basename(paths.sourcePath),
    "--to=json",
    "--output=docling",
    "--image-export-mode=referenced",
  ];
  if (includeMarkdown) {
    arguments_.push("--to=md");
  }
  if (enrich) {
    arguments_.push("--enrich-formula");
  }
  return arguments_;
}

export async function convertBook(
  paths: BookPaths,
  candidate: RankedCandidate,
  runner: CommandRunner = runCommand,
  includeMarkdown = false
): Promise<ConversionResult> {
  const extension = candidate.entry.extension.toLowerCase();
  if (!canConvertWithDocling(extension)) {
    return {
      status: "failed",
      converter: "docling",
      message: `Docling does not support .${extension}; use --source-only or select a supported copy such as PDF.`,
    };
  }
  if (!(await commandIsAvailable("docling", runner, paths.bookDirectory))) {
    return {
      status: "failed",
      converter: "docling",
      message: "Docling is required for document conversion but is not installed.",
    };
  }

  await fs.promises.mkdir(paths.doclingDirectory, { recursive: true });
  let result = await runner(
    "docling",
    getDoclingArguments(paths, includeMarkdown, true),
    paths.bookDirectory
  );
  if (result.exitCode !== 0) {
    result = await runner(
      "docling",
      getDoclingArguments(paths, includeMarkdown, false),
      paths.bookDirectory
    );
  }

  const jsonIsValid = await validateDoclingDocument(paths.doclingJSONPath);
  const markdownIsValid = await validateOptionalMarkdown(paths, includeMarkdown);
  if (result.exitCode !== 0 || !jsonIsValid || !markdownIsValid) {
    return {
      status: "failed",
      converter: "docling",
      message: result.stderr.trim() || "Docling did not produce the requested native output.",
    };
  }

  const conversion: ConversionResult = {
    status: "converted",
    converter: "docling",
    message: "Converted the document to native DoclingDocument JSON.",
    doclingJSONPath: paths.doclingJSONPath,
  };
  if (includeMarkdown) {
    conversion.message = "Converted the document to native DoclingDocument JSON and Markdown.";
    conversion.doclingMarkdownPath = paths.doclingMarkdownPath;
  }
  return conversion;
}

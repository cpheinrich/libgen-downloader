import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { addMarkdownFrontmatter } from "./metadata";
import type { BookPaths, ConversionResult, RankedCandidate } from "./types";

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
      { cwd: workingDirectory, maxBuffer: 10 * 1024 * 1024 },
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

async function normalizeDoclingOutput(paths: BookPaths): Promise<void> {
  const generatedMarkdown = path.join(paths.bookDirectory, "source.md");
  if (generatedMarkdown !== paths.markdownPath && fs.existsSync(generatedMarkdown)) {
    await fs.promises.rename(generatedMarkdown, paths.markdownPath);
  }

  const generatedAssets = path.join(paths.bookDirectory, "source_artifacts");
  if (!fs.existsSync(generatedAssets)) {
    return;
  }

  await fs.promises.mkdir(paths.assetsDirectory, { recursive: true });
  await fs.promises.cp(generatedAssets, paths.assetsDirectory, { recursive: true });
  await fs.promises.rm(generatedAssets, { recursive: true, force: true });

  const markdown = await fs.promises.readFile(paths.markdownPath, "utf8");
  await fs.promises.writeFile(
    paths.markdownPath,
    markdown.replaceAll("source_artifacts/", "assets/")
  );
}

async function convertTextSource(
  paths: BookPaths,
  candidate: RankedCandidate
): Promise<ConversionResult> {
  await fs.promises.copyFile(paths.sourcePath, paths.markdownPath);
  await addMarkdownFrontmatter(paths.markdownPath, candidate.entry, candidate.md5);
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
      "--to=gfm+tex_math_dollars",
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

  await addMarkdownFrontmatter(paths.markdownPath, candidate.entry, candidate.md5);
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
  runner: CommandRunner
): Promise<ConversionResult> {
  if (!(await commandIsAvailable("docling", runner, paths.bookDirectory))) {
    return {
      status: "unavailable",
      converter: "docling",
      message: "Docling is not installed; the original source was retained for later conversion.",
    };
  }

  const arguments_ = [
    "convert",
    path.basename(paths.sourcePath),
    "--to=md",
    "--output=.",
    "--image-export-mode=referenced",
    "--enrich-formula",
    "--enrich-chart-extraction",
    "--quiet",
  ];
  let result = await runner("docling", arguments_, paths.bookDirectory);

  if (result.exitCode !== 0) {
    result = await runner(
      "docling",
      [
        "convert",
        path.basename(paths.sourcePath),
        "--to=md",
        "--output=.",
        "--image-export-mode=referenced",
        "--quiet",
      ],
      paths.bookDirectory
    );
  }

  if (result.exitCode === 0) {
    await normalizeDoclingOutput(paths);
  }

  if (result.exitCode !== 0 || !(await validateMarkdown(paths.markdownPath))) {
    return {
      status: "failed",
      converter: "docling",
      message: result.stderr.trim() || "Docling did not produce usable Markdown.",
    };
  }

  await addMarkdownFrontmatter(paths.markdownPath, candidate.entry, candidate.md5);
  return {
    status: "converted",
    converter: "docling",
    message: "Converted the document with Docling, including referenced assets.",
    markdownPath: paths.markdownPath,
  };
}

export async function convertBook(
  paths: BookPaths,
  candidate: RankedCandidate,
  runner: CommandRunner = runCommand
): Promise<ConversionResult> {
  await fs.promises.mkdir(paths.assetsDirectory, { recursive: true });
  const extension = candidate.entry.extension.toLowerCase();

  if (["md", "markdown", "txt"].includes(extension)) {
    return convertTextSource(paths, candidate);
  }
  if (["pdf", "djvu"].includes(extension)) {
    return convertWithDocling(paths, candidate, runner);
  }
  if (["epub", "docx", "html", "htm", "mobi", "azw3", "fb2", "rtf", "odt"].includes(extension)) {
    return convertWithPandoc(paths, candidate, runner);
  }

  return {
    status: "unavailable",
    message: `No Markdown converter is configured for .${extension} files.`,
  };
}

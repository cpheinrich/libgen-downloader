import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
const BRIDGED_EBOOK_EXTENSIONS = new Set(["azw", "azw3", "epub", "mobi"]);

export function canConvertWithDocling(extension: string): boolean {
  const normalizedExtension = extension.toLowerCase();
  return (
    DOCLING_INPUT_EXTENSIONS.has(normalizedExtension) ||
    BRIDGED_EBOOK_EXTENSIONS.has(normalizedExtension)
  );
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

async function executablePath(command: string): Promise<string | undefined> {
  const executableNames = [command];
  if (process.platform === "win32") {
    executableNames.unshift(`${command}.exe`);
  }
  for (const directory of (process.env.PATH || "").split(path.delimiter)) {
    for (const executableName of executableNames) {
      const candidate = path.join(directory, executableName);
      try {
        await fs.promises.access(candidate, fs.constants.X_OK);
        return await fs.promises.realpath(candidate);
      } catch {
        // Continue searching PATH.
      }
    }
  }
  return undefined;
}

async function resolveDoclingPython(): Promise<string> {
  const doclingPath = await executablePath("docling");
  if (!doclingPath) {
    throw new Error("Docling is installed but its executable could not be resolved from PATH.");
  }

  for (const executableName of ["python", "python3", "python.exe"]) {
    const candidate = path.join(path.dirname(doclingPath), executableName);
    try {
      await fs.promises.access(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Try the interpreter declared by Docling's launcher next.
    }
  }

  const launcher = await fs.promises.readFile(doclingPath, "utf8");
  const firstLine = launcher.split("\n", 1)[0] || "";
  const interpreter = firstLine.match(/^#!\s*(\/\S+)/)?.[1];
  if (interpreter) {
    await fs.promises.access(interpreter, fs.constants.X_OK);
    return interpreter;
  }
  throw new Error("Could not locate the Python environment that contains Docling.");
}

async function resolveExporterPath(): Promise<string> {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(moduleDirectory, "../../scripts/docling_export.py"),
    path.resolve(moduleDirectory, "../scripts/docling_export.py"),
  ];
  for (const candidate of candidates) {
    try {
      await fs.promises.access(candidate, fs.constants.R_OK);
      return candidate;
    } catch {
      // The source and bundled package layouts differ by one directory.
    }
  }
  throw new Error("The bundled Docling exporter script is missing.");
}

async function findHTMLFiles(directory: string): Promise<string[]> {
  const matches: string[] = [];
  for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      matches.push(...(await findHTMLFiles(entryPath)));
    } else if (/\.x?html?$/i.test(entry.name)) {
      matches.push(entryPath);
    }
  }
  return matches;
}

async function getLargestHTMLFile(directory: string): Promise<string> {
  const htmlFiles = await findHTMLFiles(directory);
  if (htmlFiles.length === 0) {
    throw new Error("The MOBI unpacker did not produce an HTML document.");
  }
  const sizes = await Promise.all(
    htmlFiles.map(async (filePath) => {
      const stat = await fs.promises.stat(filePath);
      return { filePath, size: stat.size };
    })
  );
  sizes.sort((first, second) => second.size - first.size);
  return sizes[0]?.filePath || htmlFiles[0];
}

async function normalizeHTMLToUTF8(sourcePath: string, outputPath: string): Promise<void> {
  const source = await fs.promises.readFile(sourcePath);
  const header = source.subarray(0, 4096).toString("ascii");
  const declaredCharset = header.match(/charset\s*=\s*["']?([^\s"'/>;]+)/i)?.[1];
  let charset = declaredCharset || "windows-1252";
  let text: string;
  try {
    text = new TextDecoder(charset).decode(source);
  } catch {
    charset = "windows-1252";
    text = new TextDecoder(charset).decode(source);
  }
  await fs.promises.writeFile(outputPath, text, "utf8");
}

async function runRequiredCommand(
  runner: CommandRunner,
  command: string,
  arguments_: string[],
  workingDirectory: string,
  failureMessage: string
): Promise<void> {
  const result = await runner(command, arguments_, workingDirectory);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || failureMessage);
  }
}

async function prepareEbookForDocling(
  paths: BookPaths,
  extension: string,
  runner: CommandRunner
): Promise<{ bridgeDirectory: string; sourcePath: string }> {
  const bridgeDirectory = await fs.promises.mkdtemp(
    path.join(paths.bookDirectory, ".ebook-bridge-")
  );
  const docxPath = path.join(bridgeDirectory, "source.docx");
  try {
    if (extension === "epub") {
      await runRequiredCommand(
        runner,
        "pandoc",
        [paths.sourcePath, "--from=epub", "--to=docx", `--output=${docxPath}`],
        paths.bookDirectory,
        "Pandoc could not convert the EPUB source to DOCX."
      );
    } else {
      const unpackDirectory = path.join(bridgeDirectory, "unpacked");
      await runRequiredCommand(
        runner,
        "uvx",
        ["--from", "mobi", "mobiunpack", "--epub_version=3", paths.sourcePath, unpackDirectory],
        paths.bookDirectory,
        "The MOBI unpacker could not extract this ebook."
      );
      const extractedHTMLPath = await getLargestHTMLFile(unpackDirectory);
      const normalizedHTMLPath = path.join(bridgeDirectory, "source.html");
      await normalizeHTMLToUTF8(extractedHTMLPath, normalizedHTMLPath);
      await runRequiredCommand(
        runner,
        "pandoc",
        [
          normalizedHTMLPath,
          "--from=html",
          "--to=docx",
          `--resource-path=${path.dirname(extractedHTMLPath)}`,
          `--output=${docxPath}`,
        ],
        paths.bookDirectory,
        "Pandoc could not convert the extracted ebook to DOCX."
      );
    }
    return { bridgeDirectory, sourcePath: docxPath };
  } catch (error) {
    await fs.promises.rm(bridgeDirectory, { recursive: true, force: true });
    throw error;
  }
}

async function validateDoclingDocument(doclingPath: string): Promise<boolean> {
  try {
    const document = JSON.parse(await fs.promises.readFile(doclingPath, "utf8"));
    if (document?.schema_name !== "DoclingDocument") {
      return false;
    }
    if (
      Array.isArray(document.pages) &&
      document.pages.some((page: { image?: unknown }) => page.image)
    ) {
      return false;
    }
    if (!Array.isArray(document.pictures)) {
      return true;
    }
    for (const picture of document.pictures) {
      const uri = picture?.image?.uri;
      if (typeof uri !== "string") {
        continue;
      }
      if (uri.startsWith("data:") || path.isAbsolute(uri)) {
        return false;
      }
      await fs.promises.access(path.resolve(path.dirname(doclingPath), uri), fs.constants.R_OK);
    }
    return true;
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

function getDoclingArguments(
  exporterPath: string,
  sourcePath: string,
  paths: BookPaths,
  includeMarkdown: boolean
) {
  const arguments_ = [exporterPath, sourcePath, paths.doclingDirectory];
  if (includeMarkdown) {
    arguments_.push("--markdown");
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
      message: `The conversion pipeline does not support .${extension}; use --source-only or select PDF, EPUB, MOBI, or another supported copy.`,
    };
  }
  if (!(await commandIsAvailable("docling", runner, paths.bookDirectory))) {
    return {
      status: "failed",
      converter: "docling",
      message: "Docling is required for document conversion but is not installed.",
    };
  }
  if (
    BRIDGED_EBOOK_EXTENSIONS.has(extension) &&
    !(await commandIsAvailable("pandoc", runner, paths.bookDirectory))
  ) {
    return {
      status: "failed",
      converter: "docling",
      message: "Pandoc is required to prepare EPUB, MOBI, and AZW ebooks for Docling.",
    };
  }
  if (
    extension !== "epub" &&
    BRIDGED_EBOOK_EXTENSIONS.has(extension) &&
    !(await commandIsAvailable("uvx", runner, paths.bookDirectory))
  ) {
    return {
      status: "failed",
      converter: "docling",
      message: "uvx is required to unpack MOBI and AZW ebooks before Docling conversion.",
    };
  }

  await fs.promises.mkdir(paths.doclingDirectory, { recursive: true });
  let pythonCommand = "python3";
  let exporterPath: string;
  try {
    exporterPath = await resolveExporterPath();
    if (runner === runCommand) {
      pythonCommand = await resolveDoclingPython();
    }
  } catch (error) {
    let message = "Could not initialize Docling export.";
    if (error instanceof Error) {
      message = error.message;
    }
    return {
      status: "failed",
      converter: "docling",
      message,
    };
  }
  let bridgeDirectory: string | undefined;
  let conversionSourcePath = paths.sourcePath;
  let result: CommandResult;
  try {
    if (BRIDGED_EBOOK_EXTENSIONS.has(extension)) {
      const prepared = await prepareEbookForDocling(paths, extension, runner);
      bridgeDirectory = prepared.bridgeDirectory;
      conversionSourcePath = prepared.sourcePath;
    }
    result = await runner(
      pythonCommand,
      getDoclingArguments(exporterPath, conversionSourcePath, paths, includeMarkdown),
      paths.bookDirectory
    );
  } catch (error) {
    let message = "Could not prepare the ebook for Docling conversion.";
    if (error instanceof Error) {
      message = error.message;
    }
    return { status: "failed", converter: "docling", message };
  } finally {
    if (bridgeDirectory) {
      await fs.promises.rm(bridgeDirectory, { recursive: true, force: true });
    }
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
  if (BRIDGED_EBOOK_EXTENSIONS.has(extension)) {
    conversion.message = `Converted the .${extension} ebook through a text-preserving bridge to native DoclingDocument JSON.`;
  }
  if (includeMarkdown) {
    conversion.message = "Converted the document to native DoclingDocument JSON and Markdown.";
    if (BRIDGED_EBOOK_EXTENSIONS.has(extension)) {
      conversion.message = `Converted the .${extension} ebook through a text-preserving bridge to native DoclingDocument JSON and Markdown.`;
    }
    conversion.doclingMarkdownPath = paths.doclingMarkdownPath;
  }
  return conversion;
}

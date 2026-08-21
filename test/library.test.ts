import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { strToU8, zipSync } from "fflate";
import { LibgenPlusAdapter } from "../src/api/adapters/libgen-plus-adapter";
import type { Entry } from "../src/api/models/entry";
import { rankCandidates } from "../src/library/candidates";
import { canConvertWithDocling, convertBook } from "../src/library/converter";
import { ingestBestBook } from "../src/library/ingest";
import { importLocalBook, inferFilenameMetadata } from "../src/library/local-import";
import { createBookPaths, getCanonicalStem, slugify } from "../src/library/naming";
import { parseReadingList } from "../src/library/reading-list";

const createEntry = (overrides: Partial<Entry> = {}): Entry => ({
  id: "entry-1",
  authors: "Sun Tzu",
  title: "The Art of War",
  publisher: "Example Press",
  year: "2024",
  pages: "300",
  language: "English",
  size: "2 MB",
  extension: "pdf",
  mirror: "/ads.php?md5=pdf-copy",
  ...overrides,
});

afterEach(() => {
  mock.restore();
});

describe("canonical library naming", () => {
  it("creates stable book folders around untouched Docling output", () => {
    const entry = createEntry({ authors: "García Márquez, Gabriel", title: "One Hundred Years!" });
    const paths = createBookPaths(entry, "/tmp/library-root");

    expect(getCanonicalStem(entry)).toBe("garcia-marquez_one-hundred-years");
    expect(paths.bookDirectory).toBe(
      path.join("/tmp/library-root", "garcia-marquez_one-hundred-years")
    );
    expect(paths.sourcePath).toEndWith("/source.pdf");
    expect(paths.doclingDirectory).toEndWith("/docling");
    expect(paths.doclingJSONPath).toEndWith("/docling/source.json");
    expect(paths.doclingMarkdownPath).toEndWith("/docling/source.md");
    expect(paths.doclingAssetsDirectory).toEndWith("/docling/source_artifacts");
    expect(slugify("  A/B & C  ")).toBe("a-b-and-c");
  });
});

describe("local library imports", () => {
  it("infers title and author from common local filenames", () => {
    expect(inferFilenameMetadata("The Selfish Gene by Richard Dawkins.epub")).toEqual({
      title: "The Selfish Gene",
      author: "Richard Dawkins",
    });
    expect(inferFilenameMetadata("Feynman, Richard Phillips - Surely You're Joking.rtf")).toEqual({
      title: "Surely You're Joking",
      author: "Richard Phillips Feynman",
    });
  });

  it("can retain an unsupported local source without converting it", async () => {
    const sourceRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "libgen-source-"));
    const libraryRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "libgen-import-"));
    const sourcePath = path.join(sourceRoot, "Example Book by Example Author.epub");
    const epub = zipSync({
      "OEBPS/content.opf": strToU8(`
        <package><metadata><dc:title>Example Book</dc:title><dc:creator>Example Author</dc:creator>
        <dc:language>eng</dc:language></metadata></package>`),
    });
    await fs.promises.writeFile(sourcePath, epub);

    try {
      const result = await importLocalBook(sourcePath, { libraryRoot, convert: false });

      expect(result.status).toBe("downloaded");
      expect(result.paths?.bookDirectory).toBe(
        path.join(libraryRoot, "example-author_example-book")
      );
      expect(await fs.promises.readFile(result.paths?.sourcePath || "")).toEqual(Buffer.from(epub));
      expect(fs.existsSync(result.paths?.doclingDirectory || "")).toBe(false);
    } finally {
      await fs.promises.rm(sourceRoot, { recursive: true, force: true });
      await fs.promises.rm(libraryRoot, { recursive: true, force: true });
    }
  });

  it("records native Docling JSON and optional untouched Markdown", async () => {
    const sourceRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "libgen-pdf-source-"));
    const libraryRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "libgen-pdf-import-"));
    const sourcePath = path.join(sourceRoot, "Example Book by Example Author.pdf");
    const source = Buffer.from("%PDF-local-source");
    const nativeMarkdown = "# Docling heading\n\n![Map](source_artifacts/map.png)\n";
    await fs.promises.writeFile(sourcePath, source);

    try {
      const result = await importLocalBook(sourcePath, {
        libraryRoot,
        includeMarkdown: true,
        runner: async (_command, arguments_, workingDirectory) => {
          if (arguments_.includes("--version")) {
            return { exitCode: 0, stdout: "Docling 2", stderr: "" };
          }
          const outputDirectory = path.join(workingDirectory, "docling");
          await fs.promises.writeFile(
            path.join(outputDirectory, "source.json"),
            JSON.stringify({ schema_name: "DoclingDocument", version: "1.9.0" })
          );
          await fs.promises.writeFile(path.join(outputDirectory, "source.md"), nativeMarkdown);
          await fs.promises.mkdir(path.join(outputDirectory, "source_artifacts"));
          await fs.promises.writeFile(
            path.join(outputDirectory, "source_artifacts", "map.png"),
            "image"
          );
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      });

      expect(result.status).toBe("downloaded");
      expect(await fs.promises.readFile(result.paths?.doclingMarkdownPath || "", "utf8")).toBe(
        nativeMarkdown
      );
      expect(fs.existsSync(result.paths?.doclingJSONPath || "")).toBe(true);
      expect(fs.existsSync(path.join(result.paths?.doclingAssetsDirectory || "", "map.png"))).toBe(
        true
      );
      expect(await fs.promises.readFile(sourcePath)).toEqual(source);
      const conversion = JSON.parse(
        await fs.promises.readFile(result.paths?.conversionPath || "", "utf8")
      );
      expect(conversion.doclingJSONPath).toBe("docling/source.json");
      expect(conversion.doclingMarkdownPath).toBe("docling/source.md");
    } finally {
      await fs.promises.rm(sourceRoot, { recursive: true, force: true });
      await fs.promises.rm(libraryRoot, { recursive: true, force: true });
    }
  });
});

describe("Markdown reading lists", () => {
  it("parses bullets, tasks, numbered items, and author hints", () => {
    const requests = parseReadingList(`
# Reading list
- The Art of War — Sun Tzu
- [ ] Gödel, Escher, Bach by Douglas Hofstadter
1. A Brief History of Time
* A Brief History of Time
`);

    expect(requests).toHaveLength(3);
    expect(requests[0]).toMatchObject({
      query: "The Art of War",
      title: "The Art of War",
      author: "Sun Tzu",
    });
    expect(requests[1]).toMatchObject({
      query: "Gödel, Escher, Bach",
      author: "Douglas Hofstadter",
    });
    expect(requests[2]?.query).toBe("A Brief History of Time");
  });
});

describe("best-copy ranking", () => {
  it("still ranks source quality independently from converter compatibility", () => {
    const request = {
      query: "The Art of War",
      title: "The Art of War",
      author: "Sun Tzu",
      sourceLine: "The Art of War — Sun Tzu",
    };
    const candidates = rankCandidates(
      [
        createEntry({ extension: "pdf", mirror: "/ads.php?md5=pdf-copy" }),
        createEntry({ extension: "epub", mirror: "/ads.php?md5=epub-copy" }),
      ],
      request
    );

    expect(candidates[0]?.md5).toBe("epub-copy");
  });

  it("prefers an exact title segment over an article containing the title words", () => {
    const request = {
      query: "The Art of War",
      title: "The Art of War",
      sourceLine: "The Art of War",
    };
    const candidates = rankCandidates(
      [
        createEntry({
          title:
            "Public Art Dialogue / Real Art, War, and the Politics of Peace Memorials after the War",
          mirror: "/ads.php?md5=article-copy",
        }),
        createEntry({
          title: "Classics / The Art of War / 9780000000000",
          mirror: "/ads.php?md5=exact-segment-copy",
        }),
      ],
      request
    );

    expect(candidates[0]?.md5).toBe("exact-segment-copy");
    expect(candidates[0]?.reasons).toContain("exact title match");
  });
});

describe("Docling conversion", () => {
  it("recognizes supported native source formats", () => {
    expect(canConvertWithDocling("PDF")).toBe(true);
    expect(canConvertWithDocling("docx")).toBe(true);
    expect(canConvertWithDocling("epub")).toBe(false);
  });

  it("produces native JSON by default without Markdown", async () => {
    const libraryRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "libgen-docling-json-"));
    const entry = createEntry();
    const paths = createBookPaths(entry, libraryRoot);
    await fs.promises.mkdir(paths.bookDirectory, { recursive: true });
    await fs.promises.writeFile(paths.sourcePath, "%PDF-test-source");
    let conversionArguments: string[] = [];

    try {
      const conversion = await convertBook(
        paths,
        { entry, md5: "pdf-copy", score: 200, reasons: ["exact title match"] },
        async (_command, arguments_) => {
          if (arguments_.includes("--version")) {
            return { exitCode: 0, stdout: "Docling 2", stderr: "" };
          }
          conversionArguments = arguments_;
          await fs.promises.writeFile(
            paths.doclingJSONPath,
            JSON.stringify({ schema_name: "DoclingDocument", version: "1.9.0" })
          );
          return { exitCode: 0, stdout: "", stderr: "" };
        }
      );

      expect(conversion.status).toBe("converted");
      expect(conversionArguments[0]).toEndWith("/scripts/docling_export.py");
      expect(conversionArguments[1]).toBe(paths.sourcePath);
      expect(conversionArguments[2]).toBe(paths.doclingDirectory);
      expect(conversionArguments).not.toContain("--markdown");
      expect(conversionArguments).not.toContain("--image-export-mode=referenced");
      expect(fs.existsSync(paths.doclingJSONPath)).toBe(true);
      expect(fs.existsSync(paths.doclingMarkdownPath)).toBe(false);
    } finally {
      await fs.promises.rm(libraryRoot, { recursive: true, force: true });
    }
  });

  it("optionally asks Docling for Markdown in the same parse", async () => {
    const libraryRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "libgen-docling-md-"));
    const entry = createEntry();
    const paths = createBookPaths(entry, libraryRoot);
    await fs.promises.mkdir(paths.bookDirectory, { recursive: true });
    await fs.promises.writeFile(paths.sourcePath, "%PDF-test-source");
    const nativeMarkdown = "# Native Docling\n\nFormula: $x^2$\n";
    let conversionArguments: string[] = [];

    try {
      const conversion = await convertBook(
        paths,
        { entry, md5: "pdf-copy", score: 200, reasons: ["exact title match"] },
        async (_command, arguments_) => {
          if (arguments_.includes("--version")) {
            return { exitCode: 0, stdout: "Docling 2", stderr: "" };
          }
          conversionArguments = arguments_;
          await fs.promises.writeFile(
            paths.doclingJSONPath,
            JSON.stringify({ schema_name: "DoclingDocument", version: "1.9.0" })
          );
          await fs.promises.writeFile(paths.doclingMarkdownPath, nativeMarkdown);
          return { exitCode: 0, stdout: "", stderr: "" };
        },
        true
      );

      expect(conversion.status).toBe("converted");
      expect(conversionArguments).toContain("--markdown");
      expect(await fs.promises.readFile(paths.doclingMarkdownPath, "utf8")).toBe(nativeMarkdown);
    } finally {
      await fs.promises.rm(libraryRoot, { recursive: true, force: true });
    }
  });

  it("rejects non-portable Docling output that references staging paths", async () => {
    const libraryRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "libgen-docling-paths-"));
    const entry = createEntry();
    const paths = createBookPaths(entry, libraryRoot);
    await fs.promises.mkdir(paths.bookDirectory, { recursive: true });
    await fs.promises.writeFile(paths.sourcePath, "%PDF-test-source");

    try {
      const conversion = await convertBook(
        paths,
        { entry, md5: "pdf-copy", score: 200, reasons: ["exact title match"] },
        async (_command, arguments_) => {
          if (arguments_.includes("--version")) {
            return { exitCode: 0, stdout: "Docling 2", stderr: "" };
          }
          await fs.promises.writeFile(
            paths.doclingJSONPath,
            JSON.stringify({
              schema_name: "DoclingDocument",
              pictures: [{ image: { uri: "/tmp/staging/source_artifacts/image.png" } }],
            })
          );
          return { exitCode: 0, stdout: "", stderr: "" };
        }
      );

      expect(conversion.status).toBe("failed");
      expect(conversion.message).toContain("did not produce the requested native output");
    } finally {
      await fs.promises.rm(libraryRoot, { recursive: true, force: true });
    }
  });

  it("rejects source formats Docling cannot parse", async () => {
    const libraryRoot = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "libgen-docling-unsupported-")
    );
    const entry = createEntry({ extension: "epub" });
    const paths = createBookPaths(entry, libraryRoot);

    try {
      const conversion = await convertBook(paths, {
        entry,
        md5: "epub-copy",
        score: 200,
        reasons: ["exact title match"],
      });

      expect(conversion.status).toBe("failed");
      expect(conversion.message).toContain("use --source-only or select a supported copy");
    } finally {
      await fs.promises.rm(libraryRoot, { recursive: true, force: true });
    }
  });
});

describe("headless ingestion", () => {
  it("can retain an unsupported source when conversion is disabled", async () => {
    const libraryRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "libgen-library-"));
    const searchHTML = `
      <table id="tablelibgen"><tbody>
        <tr>
          <td><a>The Art of War</a></td><td>Sun Tzu</td><td>Example Press</td>
          <td>2024</td><td>English</td><td>300</td><td>2 MB</td><td>epub</td>
          <td><a href="/ads.php?md5=epub-copy">Mirror</a></td>
        </tr>
      </tbody></table>`;
    const fetchMock = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        async (input: RequestInfo | URL) => {
          const url = input.toString();
          if (url.includes("/index.php")) {
            return new Response(searchHTML);
          }
          if (url.includes("/ads.php?md5=epub-copy")) {
            return new Response(
              '<table id="main"><tr><td>Book</td><td><a href="/files/book.epub">GET</a></td></tr></table>'
            );
          }
          if (url.endsWith("/files/book.epub")) {
            return new Response("PK-valid-epub", {
              headers: {
                "content-disposition": 'attachment; filename="chaotic-name.epub"',
                "content-length": "13",
              },
            });
          }
          return new Response("Not found", { status: 404 });
        },
        { preconnect() {} }
      )
    );

    try {
      const result = await ingestBestBook(
        {
          query: "The Art of War",
          title: "The Art of War",
          author: "Sun Tzu",
          sourceLine: "The Art of War — Sun Tzu",
        },
        {
          libraryRoot,
          pageCount: 1,
          finalistCount: 1,
          convert: false,
          session: {
            mirror: { src: "https://libgen.example/", type: "libgen-plus" },
            adapter: new LibgenPlusAdapter("https://libgen.example/"),
          },
        }
      );

      expect(result.status).toBe("downloaded");
      expect(await fs.promises.readFile(result.paths?.sourcePath || "", "utf8")).toBe(
        "PK-valid-epub"
      );
      expect(fs.existsSync(result.paths?.doclingDirectory || "")).toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    } finally {
      await fs.promises.rm(libraryRoot, { recursive: true, force: true });
    }
  });

  it("does not download candidates incompatible with required Docling conversion", async () => {
    const libraryRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "libgen-filter-"));
    const searchHTML = `
      <table id="tablelibgen"><tbody><tr>
        <td><a>The Art of War</a></td><td>Sun Tzu</td><td>Example Press</td>
        <td>2024</td><td>English</td><td>300</td><td>2 MB</td><td>epub</td>
        <td><a href="/ads.php?md5=epub-copy">Mirror</a></td>
      </tr></tbody></table>`;
    const fetchMock = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(async () => new Response(searchHTML), { preconnect() {} })
    );

    try {
      const result = await ingestBestBook(
        { query: "The Art of War", sourceLine: "The Art of War" },
        {
          libraryRoot,
          pageCount: 1,
          session: {
            mirror: { src: "https://libgen.example/", type: "libgen-plus" },
            adapter: new LibgenPlusAdapter("https://libgen.example/"),
          },
        }
      );

      expect(result.status).toBe("failed");
      expect(result.message).toContain("support native Docling output");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      await fs.promises.rm(libraryRoot, { recursive: true, force: true });
    }
  });
});

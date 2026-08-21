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
  extension: "epub",
  mirror: "/ads.php?md5=epub-copy",
  ...overrides,
});

afterEach(() => {
  mock.restore();
});

describe("canonical library naming", () => {
  it("creates stable author_title folders and standardized files", () => {
    const entry = createEntry({ authors: "García Márquez, Gabriel", title: "One Hundred Years!" });
    const paths = createBookPaths(entry, "/tmp/library-root");

    expect(getCanonicalStem(entry)).toBe("garcia-marquez_one-hundred-years");
    expect(paths.bookDirectory).toBe(
      path.join("/tmp/library-root", "garcia-marquez_one-hundred-years")
    );
    expect(paths.sourcePath).toEndWith("/source.epub");
    expect(paths.markdownPath).toEndWith("/book.md");
    expect(paths.assetsDirectory).toEndWith("/assets");
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

  it("imports an EPUB, restores headings, and links supplemental front matter", async () => {
    const sourceRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "libgen-source-"));
    const libraryRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "libgen-import-"));
    const sourcePath = path.join(sourceRoot, "The Selfish Gene by Richard Dawkins.epub");
    const epub = zipSync({
      "OEBPS/content.opf": strToU8(`
        <package><metadata><dc:title>The Selfish Gene</dc:title><dc:language>eng</dc:language></metadata>
        <manifest><item id="cover-page" href="cover.xhtml"/></manifest>
        <spine><itemref idref="cover-page" linear="no"/></spine></package>`),
      "OEBPS/cover.xhtml": strToU8('<html><body><img src="images/cover.jpg"/></body></html>'),
      "OEBPS/images/cover.jpg": new Uint8Array([1, 2, 3, 4]),
    });
    await fs.promises.writeFile(sourcePath, epub);

    try {
      const result = await importLocalBook(sourcePath, {
        libraryRoot,
        runner: async (_command, arguments_, workingDirectory) => {
          if (arguments_.includes("--version")) {
            return { exitCode: 0, stdout: "pandoc 3", stderr: "" };
          }
          await fs.promises.writeFile(
            path.join(workingDirectory, "book.md"),
            [
              "RICHARD DAWKINS Contents",
              "",
              String.raw`1\. Why are people?`,
              "",
              String.raw`1\. Why are people?`,
              "",
              "This converted chapter contains enough words to pass canonical validation cleanly.",
              "",
              "A sentence interrupted at a scanned page boundary",
              "",
              "continues in lowercase on the next page.",
            ].join("\n")
          );
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      });

      expect(result.status).toBe("downloaded");
      expect(result.paths?.bookDirectory).toBe(
        path.join(libraryRoot, "richard-dawkins_the-selfish-gene")
      );
      const markdown = await fs.promises.readFile(result.paths?.markdownPath || "", "utf8");
      expect(markdown).toContain('source_kind: "local"');
      expect(markdown).toContain("# The Selfish Gene");
      expect(markdown).toContain("## Contents");
      expect(markdown).toContain("## 1. Why are people?");
      expect(markdown).toContain(
        "A sentence interrupted at a scanned page boundary continues in lowercase on the next page."
      );
      expect(markdown).toContain("![Book cover](assets/front-matter-001.jpg)");
      expect(
        fs.existsSync(path.join(result.paths?.assetsDirectory || "", "front-matter-001.jpg"))
      ).toBe(true);
      expect(result.conversion?.validation?.valid).toBe(true);
      expect(await fs.promises.readFile(sourcePath)).toEqual(Buffer.from(epub));
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
  it("prefers an exact, author-matched EPUB over weaker copies", () => {
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
        createEntry({
          title: "The Art Book",
          authors: "Another Author",
          extension: "epub",
          mirror: "/ads.php?md5=wrong-copy",
        }),
      ],
      request
    );

    expect(candidates[0]?.md5).toBe("epub-copy");
    expect(candidates.at(-1)?.md5).toBe("wrong-copy");
  });

  it("prefers an exact title segment over an article that merely contains all title words", () => {
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

describe("Markdown conversion", () => {
  it("recognizes Docling-native source formats", () => {
    expect(canConvertWithDocling("PDF")).toBe(true);
    expect(canConvertWithDocling("docx")).toBe(true);
    expect(canConvertWithDocling("epub")).toBe(false);
  });

  it("converts structured sources with Pandoc and adds canonical frontmatter", async () => {
    const libraryRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "libgen-convert-"));
    const entry = createEntry();
    const paths = createBookPaths(entry, libraryRoot);
    await fs.promises.mkdir(paths.bookDirectory, { recursive: true });
    await fs.promises.writeFile(paths.sourcePath, "PK-epub-source");

    try {
      const conversion = await convertBook(
        paths,
        {
          entry,
          md5: "epub-copy",
          score: 200,
          reasons: ["exact title match"],
        },
        async (_command, arguments_) => {
          if (arguments_.includes("--version")) {
            return { exitCode: 0, stdout: "pandoc 3", stderr: "" };
          }
          await fs.promises.writeFile(paths.markdownPath, "# The Art of War\n\nContent.");
          return { exitCode: 0, stdout: "", stderr: "" };
        }
      );

      expect(conversion.status).toBe("converted");
      const markdown = await fs.promises.readFile(paths.markdownPath, "utf8");
      expect(markdown).toStartWith("---\n");
      expect(markdown).toContain('libgen_md5: "epub-copy"');
      expect(markdown).toContain("# The Art of War");
    } finally {
      await fs.promises.rm(libraryRoot, { recursive: true, force: true });
    }
  });

  it("uses current Docling flags and retains referenced PDF assets", async () => {
    const libraryRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "libgen-docling-"));
    const entry = createEntry({ extension: "pdf" });
    const paths = createBookPaths(entry, libraryRoot);
    await fs.promises.mkdir(paths.bookDirectory, { recursive: true });
    await fs.promises.writeFile(paths.sourcePath, "%PDF-test-source");
    let conversionArguments: string[] = [];

    try {
      const conversion = await convertBook(
        paths,
        {
          entry,
          md5: "pdf-copy",
          score: 200,
          reasons: ["exact title match"],
        },
        async (_command, arguments_, workingDirectory) => {
          if (arguments_.includes("--version")) {
            return { exitCode: 0, stdout: "Docling 2", stderr: "" };
          }
          conversionArguments = arguments_;
          await fs.promises.writeFile(
            path.join(workingDirectory, "source.md"),
            "# The Art of War\n\n![Map](source_artifacts/map.png)\n\nCanonical content."
          );
          await fs.promises.mkdir(path.join(workingDirectory, "source_artifacts"));
          await fs.promises.writeFile(
            path.join(workingDirectory, "source_artifacts", "map.png"),
            "image"
          );
          return { exitCode: 0, stdout: "", stderr: "" };
        }
      );

      expect(conversion.status).toBe("converted");
      expect(conversionArguments[0]).toBe("source.pdf");
      expect(conversionArguments).toContain("--enrich-formula");
      expect(conversionArguments).not.toContain("--quiet");
      expect(conversionArguments).not.toContain("--enrich-chart-extraction");
      const markdown = await fs.promises.readFile(paths.markdownPath, "utf8");
      expect(markdown).toContain("![Map](assets/map.png)");
      expect(fs.existsSync(path.join(paths.assetsDirectory, "map.png"))).toBe(true);
    } finally {
      await fs.promises.rm(libraryRoot, { recursive: true, force: true });
    }
  });

  it("can retain Markdown and native DoclingDocument JSON from one conversion", async () => {
    const libraryRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "libgen-docling-both-"));
    const entry = createEntry({ extension: "pdf" });
    const paths = createBookPaths(entry, libraryRoot);
    await fs.promises.mkdir(paths.bookDirectory, { recursive: true });
    await fs.promises.writeFile(paths.sourcePath, "%PDF-test-source");
    let conversionArguments: string[] = [];

    try {
      const conversion = await convertBook(
        paths,
        {
          entry,
          md5: "pdf-copy",
          score: 200,
          reasons: ["exact title match"],
        },
        async (_command, arguments_, workingDirectory) => {
          if (arguments_.includes("--version")) {
            return { exitCode: 0, stdout: "Docling 2", stderr: "" };
          }
          conversionArguments = arguments_;
          await fs.promises.writeFile(
            path.join(workingDirectory, "source.md"),
            "# The Art of War\n\nCanonical Markdown content generated from the source PDF."
          );
          await fs.promises.writeFile(
            path.join(workingDirectory, "source.json"),
            JSON.stringify({ schema_name: "DoclingDocument", version: "1.0.0" })
          );
          return { exitCode: 0, stdout: "", stderr: "" };
        },
        "both"
      );

      expect(conversion.status).toBe("converted");
      expect(conversion.outputFormat).toBe("both");
      expect(conversionArguments).toContain("--to=md");
      expect(conversionArguments).toContain("--to=json");
      expect(fs.existsSync(paths.markdownPath)).toBe(true);
      expect(fs.existsSync(paths.doclingPath)).toBe(true);
      const document = JSON.parse(await fs.promises.readFile(paths.doclingPath, "utf8"));
      expect(document.schema_name).toBe("DoclingDocument");
    } finally {
      await fs.promises.rm(libraryRoot, { recursive: true, force: true });
    }
  });

  it("rejects native Docling output for unsupported ebook sources", async () => {
    const libraryRoot = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "libgen-docling-unsupported-")
    );
    const entry = createEntry({ extension: "epub" });
    const paths = createBookPaths(entry, libraryRoot);

    try {
      const conversion = await convertBook(
        paths,
        {
          entry,
          md5: "epub-copy",
          score: 200,
          reasons: ["exact title match"],
        },
        undefined,
        "docling"
      );

      expect(conversion.status).toBe("failed");
      expect(conversion.message).toContain("try --format canonical or select a PDF copy");
    } finally {
      await fs.promises.rm(libraryRoot, { recursive: true, force: true });
    }
  });
});

describe("headless ingestion", () => {
  it("searches, selects, and stores a canonical source folder", async () => {
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
      expect(result.paths?.bookDirectory).toBe(path.join(libraryRoot, "sun-tzu_the-art-of-war"));
      expect(await fs.promises.readFile(result.paths?.sourcePath || "", "utf8")).toBe(
        "PK-valid-epub"
      );
      expect(fs.existsSync(result.paths?.assetsDirectory || "")).toBe(true);
      const metadata = JSON.parse(
        await fs.promises.readFile(result.paths?.metadataPath || "", "utf8")
      );
      expect(metadata.libgenMD5).toBe("epub-copy");
      expect(fetchMock).toHaveBeenCalledTimes(3);
      const searchCall = fetchMock.mock.calls[0]?.[0]?.toString() || "";
      expect(new URL(searchCall).searchParams.get("req")).toBe("The Art of War Sun Tzu");
    } finally {
      await fs.promises.rm(libraryRoot, { recursive: true, force: true });
    }
  });
});

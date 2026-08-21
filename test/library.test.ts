import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LibgenPlusAdapter } from "../src/api/adapters/libgen-plus-adapter";
import type { Entry } from "../src/api/models/entry";
import { rankCandidates } from "../src/library/candidates";
import { convertBook } from "../src/library/converter";
import { ingestBestBook } from "../src/library/ingest";
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

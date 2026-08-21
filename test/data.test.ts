import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { fetchConfig, findMirror } from "../src/api/data/config";
import { getDocument } from "../src/api/data/document";
import { LIBGEN_REQUEST_OPTIONS } from "../src/api/data/request";

afterEach(() => {
  mock.restore();
});

describe("configuration data", () => {
  it("normalizes the remote configuration response", async () => {
    spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        latest_version: "4.0.0",
        mirrors: [{ src: "https://mirror.example/", type: "libgen-plus" }],
      })
    );

    await expect(fetchConfig()).resolves.toEqual({
      latestVersion: "4.0.0",
      mirrors: [{ src: "https://mirror.example/", type: "libgen-plus" }],
    });
  });

  it("prioritizes libgen.bz while preserving the other mirror order", async () => {
    spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        latest_version: "4.0.0",
        mirrors: [
          { src: "https://libgen.li/", type: "libgen-plus" },
          { src: "https://libgen.bz", type: "libgen-plus" },
          { src: "https://libgen.vg/", type: "libgen-plus" },
        ],
      })
    );

    const config = await fetchConfig();

    expect(config.mirrors.map((mirror) => mirror.src)).toEqual([
      "https://libgen.bz",
      "https://libgen.li/",
      "https://libgen.vg/",
    ]);
  });

  it("wraps configuration transport errors", async () => {
    spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));

    await expect(fetchConfig()).rejects.toThrow("Error occurred while fetching configuration.");
  });

  it("selects the first reachable mirror and reports failed mirrors", async () => {
    const onMirrorFail = mock(() => {});
    const fetchMock = spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(new Response("ok"));
    const mirrors = [
      { src: "https://offline.example/", type: "libgen-plus" as const },
      { src: "https://online.example/", type: "libgen-plus" as const },
    ];

    await expect(findMirror(mirrors, onMirrorFail)).resolves.toEqual(mirrors[1]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(2, "https://online.example/", LIBGEN_REQUEST_OPTIONS);
    expect(onMirrorFail).toHaveBeenCalledWith("https://offline.example/");
  });

  it("rejects mirrors that return unsuccessful HTTP responses", async () => {
    const onMirrorFail = mock(() => {});
    spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(new Response("ok"));
    const mirrors = [
      { src: "https://unavailable.example/", type: "libgen-plus" as const },
      { src: "https://online.example/", type: "libgen-plus" as const },
    ];

    await expect(findMirror(mirrors, onMirrorFail)).resolves.toEqual(mirrors[1]);
    expect(onMirrorFail).toHaveBeenCalledWith("https://unavailable.example/");
  });
});

describe("document data", () => {
  it("fetches HTML and returns a queryable document", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response('<main><h1 id="title">Example Book</h1></main>')
    );

    const result = await getDocument("https://mirror.example/book");

    expect(result.htmlString).toContain("Example Book");
    expect(result.document.querySelector("#title")?.textContent).toBe("Example Book");
    expect(fetchMock).toHaveBeenCalledWith("https://mirror.example/book", LIBGEN_REQUEST_OPTIONS);
  });

  it("wraps document transport errors with the requested URL", async () => {
    spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));

    await expect(getDocument("https://mirror.example/book")).rejects.toThrow(
      "Error occured while fetching document of https://mirror.example/book"
    );
  });
});

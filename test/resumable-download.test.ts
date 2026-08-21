import { afterEach, describe, expect, it, mock } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { downloadURLToFile } from "../src/api/data/resumable-download";

afterEach(() => {
  mock.restore();
});

describe("resumable downloads", () => {
  it("finishes at the declared byte length even when the server never closes the stream", async () => {
    const outputRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "libgen-length-"));
    const destinationPath = path.join(outputRoot, "source.pdf");
    const payload = new TextEncoder().encode("%PDF-complete-file");
    const progress: Array<[number, number | undefined]> = [];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(payload);
      },
    });

    try {
      await downloadURLToFile({
        url: "https://download.example/book",
        destinationPath,
        stallTimeoutMs: 10,
        onProgress(downloadedBytes, totalBytes) {
          progress.push([downloadedBytes, totalBytes]);
        },
        fetcher: async () =>
          new Response(stream, { headers: { "content-length": String(payload.byteLength) } }),
      });

      expect(await fs.promises.readFile(destinationPath)).toEqual(Buffer.from(payload));
      expect(progress).toEqual([[payload.byteLength, payload.byteLength]]);
      expect(fs.existsSync(`${destinationPath}.partial`)).toBe(false);
    } finally {
      await fs.promises.rm(outputRoot, { recursive: true, force: true });
    }
  });

  it("resumes with a byte range after an inactive response", async () => {
    const outputRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "libgen-resume-"));
    const destinationPath = path.join(outputRoot, "source.epub");
    const payload = new TextEncoder().encode("PK-resumable-epub");
    const firstChunk = payload.slice(0, 7);
    let fetchCount = 0;

    try {
      await downloadURLToFile({
        url: "https://download.example/book",
        destinationPath,
        stallTimeoutMs: 10,
        maxAttempts: 2,
        fetcher: async (_input, options) => {
          fetchCount += 1;
          if (fetchCount === 1) {
            return new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(firstChunk);
                },
              }),
              { headers: { "content-length": String(payload.byteLength) } }
            );
          }

          expect(new Headers(options?.headers).get("range")).toBe(
            `bytes=${firstChunk.byteLength}-`
          );
          const remainder = payload.slice(firstChunk.byteLength);
          return new Response(remainder, {
            status: 206,
            headers: {
              "content-length": String(remainder.byteLength),
              "content-range": `bytes ${firstChunk.byteLength}-${payload.byteLength - 1}/${payload.byteLength}`,
            },
          });
        },
      });

      expect(fetchCount).toBe(2);
      expect(await fs.promises.readFile(destinationPath)).toEqual(Buffer.from(payload));
    } finally {
      await fs.promises.rm(outputRoot, { recursive: true, force: true });
    }
  });

  it("times out while waiting for response headers", async () => {
    const outputRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "libgen-connect-"));
    const destinationPath = path.join(outputRoot, "source.pdf");

    try {
      await expect(
        downloadURLToFile({
          url: "https://download.example/book",
          destinationPath,
          requestTimeoutMs: 10,
          maxAttempts: 1,
          fetcher: async () => new Promise<Response>(() => {}),
        })
      ).rejects.toThrow("Download connection timed out");
      expect(fs.existsSync(destinationPath)).toBe(false);
      expect(fs.existsSync(`${destinationPath}.partial`)).toBe(false);
    } finally {
      await fs.promises.rm(outputRoot, { recursive: true, force: true });
    }
  });
});

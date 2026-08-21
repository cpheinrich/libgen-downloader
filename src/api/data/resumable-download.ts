import fs from "node:fs";

const DEFAULT_MAX_ATTEMPTS = 6;
const DEFAULT_STALL_TIMEOUT_MS = 10_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

type Fetcher = (input: string | URL, options?: RequestInit) => Promise<Response>;

interface ResumableDownloadOptions {
  url: string;
  destinationPath: string;
  fetcher: Fetcher;
  maxAttempts?: number;
  stallTimeoutMs?: number;
  requestTimeoutMs?: number;
  onRetry?: (message: string) => void;
  onProgress?: (downloadedBytes: number, totalBytes?: number) => void;
}

interface ReadResult {
  done: boolean;
  value?: Uint8Array;
}

function parseExpectedTotal(response: Response, offset: number): number | undefined {
  const contentRange = response.headers.get("content-range");
  const rangeTotal = contentRange?.match(/\/(\d+)$/)?.[1];
  if (rangeTotal) {
    return Number(rangeTotal);
  }
  const contentLength = Number(response.headers.get("content-length") || 0);
  if (contentLength > 0) {
    return offset + contentLength;
  }
  return undefined;
}

function readWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  controller: AbortController,
  timeoutMilliseconds: number
): Promise<ReadResult> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      controller.abort();
      reject(new Error(`Download stalled for ${timeoutMilliseconds}ms.`));
    }, timeoutMilliseconds);

    reader.read().then(
      (result) => {
        clearTimeout(timeout);
        resolve(result);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      }
    );
  });
}

function fetchWithTimeout(
  fetcher: Fetcher,
  url: string,
  options: RequestInit,
  controller: AbortController,
  timeoutMilliseconds: number
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      controller.abort();
      reject(new Error(`Download connection timed out after ${timeoutMilliseconds}ms.`));
    }, timeoutMilliseconds);

    fetcher(url, options).then(
      (response) => {
        clearTimeout(timeout);
        resolve(response);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      }
    );
  });
}

async function getPartialSize(partialPath: string): Promise<number> {
  try {
    const stat = await fs.promises.stat(partialPath);
    return stat.size;
  } catch {
    return 0;
  }
}

export async function downloadURLToFile({
  url,
  destinationPath,
  fetcher,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  stallTimeoutMs = DEFAULT_STALL_TIMEOUT_MS,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  onRetry = () => {},
  onProgress = () => {},
}: ResumableDownloadOptions): Promise<void> {
  const partialPath = `${destinationPath}.partial`;
  await fs.promises.rm(partialPath, { force: true });
  let lastError = "Download failed.";

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let offset = await getPartialSize(partialPath);
    const controller = new AbortController();
    const headers = new Headers();
    if (offset > 0) {
      headers.set("Range", `bytes=${offset}-`);
    }

    let file: fs.promises.FileHandle | undefined;
    try {
      const response = await fetchWithTimeout(
        fetcher,
        url,
        { headers, signal: controller.signal },
        controller,
        requestTimeoutMs
      );
      if (offset > 0 && response.status === 200) {
        offset = 0;
        await fs.promises.rm(partialPath, { force: true });
      } else if (offset > 0 && response.status !== 206) {
        throw new Error(`Range resume returned HTTP ${response.status}.`);
      } else if (!response.ok) {
        throw new Error(`Download returned HTTP ${response.status}.`);
      }
      if (!response.body) {
        throw new Error("Download response did not contain a body.");
      }

      const expectedTotal = parseExpectedTotal(response, offset);
      let writeMode = "w";
      if (offset > 0) {
        writeMode = "a";
      }
      file = await fs.promises.open(partialPath, writeMode);
      const reader = response.body.getReader();
      let downloaded = offset;
      let completed = false;

      while (!completed) {
        const result = await readWithTimeout(reader, controller, stallTimeoutMs);
        if (result.done) {
          if (expectedTotal && downloaded < expectedTotal) {
            throw new Error(`Download ended at ${downloaded} of ${expectedTotal} bytes.`);
          }
          completed = true;
          continue;
        }
        if (!result.value) {
          continue;
        }
        await file.write(result.value);
        downloaded += result.value.byteLength;
        onProgress(downloaded, expectedTotal);
        if (expectedTotal && downloaded >= expectedTotal) {
          completed = true;
          controller.abort();
        }
      }

      await file.close();
      file = undefined;
      const finalSize = await getPartialSize(partialPath);
      if (expectedTotal && finalSize !== expectedTotal) {
        throw new Error(`Download wrote ${finalSize} of ${expectedTotal} bytes.`);
      }
      await fs.promises.rename(partialPath, destinationPath);
      return;
    } catch (error) {
      controller.abort();
      if (file) {
        await file.close();
      }
      lastError = String(error);
      if (error instanceof Error) {
        lastError = error.message;
      }
      const partialSize = await getPartialSize(partialPath);
      if (attempt < maxAttempts) {
        onRetry(
          `Download interrupted at ${partialSize} bytes; resuming (attempt ${attempt + 1}/${maxAttempts})...`
        );
      }
    }
  }

  await fs.promises.rm(partialPath, { force: true });
  throw new Error(lastError);
}

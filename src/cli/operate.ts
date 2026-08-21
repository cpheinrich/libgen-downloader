import fs from "node:fs";
import { getDocument } from "../api/data/document";
import { createLibgenSession, ingestBestBook } from "../library/ingest";
import { parseBookRequest, parseReadingList } from "../library/reading-list";
import type { BookRequest, IngestionResult } from "../library/types";
import renderTUI from "../tui/index";
import { LAYOUT_KEY } from "../tui/layouts/keys";
import { useBoundStore } from "../tui/store/index";
import { attempt } from "../utilities";

function getPageCount(flags: Record<string, unknown>): number {
  const pageCount = Number.parseInt(String(flags.pages || "2"), 10);
  if (!Number.isFinite(pageCount) || pageCount < 1) {
    return 2;
  }
  return pageCount;
}

async function ingestRequests(
  requests: BookRequest[],
  flags: Record<string, unknown>
): Promise<IngestionResult[]> {
  if (requests.length === 0) {
    throw new Error("The reading list did not contain any book entries.");
  }

  const session = await createLibgenSession((mirror) => {
    console.log(`Mirror unavailable: ${mirror}`);
  });
  const results: IngestionResult[] = [];

  for (const [index, request] of requests.entries()) {
    console.log(`\n[${index + 1}/${requests.length}] ${request.sourceLine}`);
    const result = await ingestBestBook(request, {
      session,
      libraryRoot: flags.output as string | undefined,
      pageCount: getPageCount(flags),
      convert: flags.sourceOnly !== true,
      onProgress(message) {
        console.log(`  ${message}`);
      },
    });
    console.log(`  ${result.status.toUpperCase()}: ${result.message}`);
    results.push(result);
  }

  const downloaded = results.filter((result) => result.status === "downloaded").length;
  const skipped = results.filter((result) => result.status === "skipped").length;
  const failed = results.filter((result) => result.status === "failed").length;
  console.log(`\nComplete: ${downloaded} downloaded, ${skipped} skipped, ${failed} failed.`);
  if (failed > 0) {
    process.exitCode = 1;
  }
  return results;
}

export const operate = async (flags: Record<string, unknown>) => {
  if (flags.best) {
    const request = parseBookRequest(flags.best as string);
    if (!request) {
      throw new Error("Provide a book title after --best.");
    }
    await ingestRequests([request], flags);
    return;
  }

  if (flags.list) {
    const markdown = await fs.promises.readFile(flags.list as string, "utf8");
    await ingestRequests(parseReadingList(markdown), flags);
    return;
  }

  if (flags.search) {
    const query = flags.search as string;
    if (query.length < 3) {
      console.log("Query must be at least 3 characters long");
      return;
    }

    const store = useBoundStore.getState();
    await store.fetchConfig();
    store.setSearchValue(query);
    renderTUI({
      startInCLIMode: false,
      doNotFetchConfigInitially: true,
    });
    store.handleSearchSubmit();
    return;
  }

  if (flags.bulk) {
    const filePath = flags.bulk as string;
    const data = await fs.promises.readFile(filePath, "utf8");
    const md5List = data.split("\n").filter((line) => line.trim());
    const store = useBoundStore.getState();
    await store.fetchConfig();
    renderTUI({
      startInCLIMode: true,
      doNotFetchConfigInitially: true,
      initialLayout: LAYOUT_KEY.BULK_DOWNLOAD_LAYOUT,
    });
    store.startBulkDownloadInCLI(md5List);
    return;
  }

  if (flags.url) {
    const md5 = flags.url as string;

    console.log("Fetching config...");
    await useBoundStore.getState().fetchConfig();
    const store = useBoundStore.getState();

    console.log("Finding download url...");
    const detailPageUrl = store.mirrorAdapter?.getDetailPageURL(md5);
    if (!detailPageUrl) {
      console.log("Failed to get detail page URL");
      return;
    }

    const detailPageResult = await attempt(() => getDocument(detailPageUrl));
    if (!detailPageResult) {
      console.log("Failed to get detail page document");
      return;
    }

    const downloadUrl = store.mirrorAdapter?.getMainDownloadURLFromDocument(
      detailPageResult.document
    );
    if (!downloadUrl) {
      console.log("Failed to find download url");
      return;
    }

    console.log("Here is the direct download link:");
    console.log(downloadUrl);

    return;
  }

  if (flags.download) {
    const md5 = flags.download as string;
    const md5List = [md5];
    const store = useBoundStore.getState();
    await store.fetchConfig();
    renderTUI({
      startInCLIMode: true,
      doNotFetchConfigInitially: true,
      initialLayout: LAYOUT_KEY.BULK_DOWNLOAD_LAYOUT,
    });
    store.startBulkDownloadInCLI(md5List);
    return;
  }

  renderTUI({
    startInCLIMode: false,
    doNotFetchConfigInitially: false,
  });
};

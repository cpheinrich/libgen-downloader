import contentDisposition from "content-disposition";
import fs from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { DownloadResult } from "../models/download-result";

interface DownloadFileArguments {
  downloadStream: Response;
  onStart: (filename: string, total: number) => void;
  onData: (filename: string, chunk: Buffer, total: number) => void;
  destinationPath?: string;
  filename?: string;
}

export function getResponseFilename(downloadStream: Response): string | undefined {
  const header = downloadStream.headers.get("content-disposition");
  if (!header) {
    return undefined;
  }

  return contentDisposition.parse(header).parameters.filename;
}

export const downloadFile = async ({
  downloadStream,
  onStart,
  onData,
  destinationPath,
  filename: requestedFilename,
}: DownloadFileArguments): Promise<DownloadResult> => {
  const MAX_FILE_NAME_LENGTH = 128;

  const responseFilename = getResponseFilename(downloadStream);
  if (!responseFilename && !requestedFilename) {
    throw new Error("No content-disposition header found");
  }

  let fullFileName = requestedFilename || "download.bin";
  if (!requestedFilename && responseFilename) {
    fullFileName = responseFilename;
  }
  const slicedFileName = fullFileName.slice(
    Math.max(fullFileName.length - MAX_FILE_NAME_LENGTH, 0)
  );
  const outputPath = destinationPath || `./${slicedFileName}`;
  let writePath = outputPath;
  if (destinationPath) {
    await fs.promises.mkdir(path.dirname(destinationPath), { recursive: true });
    writePath = `${destinationPath}.partial`;
  }

  const total = Number(downloadStream.headers.get("content-length") || 0);
  const filename = slicedFileName;

  if (!downloadStream.body) {
    throw new Error("No response body");
  }

  onStart(filename, total);

  const progressStream = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      const buffer = Buffer.from(chunk);
      onData(filename, buffer, total);
      callback(undefined, buffer);
    },
  });

  try {
    await pipeline(
      Readable.from(downloadStream.body, { objectMode: false }),
      progressStream,
      fs.createWriteStream(writePath)
    );

    if (destinationPath) {
      await fs.promises.rename(writePath, outputPath);
    }

    const downloadResult: DownloadResult = {
      path: outputPath,
      filename,
      total,
    };

    return downloadResult;
  } catch {
    if (destinationPath) {
      await fs.promises.rm(writePath, { force: true });
    }
    throw new Error(`(${filename}) Error occurred while downloading file`);
  }
};

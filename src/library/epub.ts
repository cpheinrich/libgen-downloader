import fs from "node:fs";
import path from "node:path";
import { unzip } from "fflate";
import type { BookPaths } from "./types";

interface EpubPackage {
  title?: string;
  authors?: string;
  publisher?: string;
  language?: string;
}

export interface SupplementalAsset {
  markdownPath: string;
  label: string;
}

function unzipArchive(sourcePath: string): Promise<Record<string, Uint8Array>> {
  return fs.promises.readFile(sourcePath).then(
    (buffer) =>
      new Promise((resolve, reject) => {
        unzip(new Uint8Array(buffer), (error, files) => {
          if (error) {
            reject(error);
            return;
          }
          resolve(files);
        });
      })
  );
}

function decodeXMLText(value: string): string {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .trim();
}

function getElementText(xml: string, elementName: string): string | undefined {
  const expression = new RegExp(
    String.raw`<${elementName}(?:\s[^>]*)?>([\s\S]*?)<\/${elementName}>`,
    "i"
  );
  const match = xml.match(expression);
  if (!match?.[1]) {
    return undefined;
  }
  const value = decodeXMLText(match[1].replaceAll(/<[^>]+>/g, ""));
  return value || undefined;
}

function getAttribute(tag: string, attribute: string): string | undefined {
  const expression = new RegExp(`${attribute}=["']([^"']+)["']`, "i");
  return tag.match(expression)?.[1];
}

function findPackageFile(files: Record<string, Uint8Array>): string | undefined {
  return Object.keys(files).find((filename) => filename.toLowerCase().endsWith(".opf"));
}

function getPackageXML(
  files: Record<string, Uint8Array>
): { filename: string; xml: string } | undefined {
  const filename = findPackageFile(files);
  if (!filename || !files[filename]) {
    return undefined;
  }
  return { filename, xml: new TextDecoder().decode(files[filename]) };
}

export async function readEpubPackage(sourcePath: string): Promise<EpubPackage> {
  const files = await unzipArchive(sourcePath);
  const packageFile = getPackageXML(files);
  if (!packageFile) {
    return {};
  }
  return {
    title: getElementText(packageFile.xml, "dc:title"),
    authors: getElementText(packageFile.xml, "dc:creator"),
    publisher: getElementText(packageFile.xml, "dc:publisher"),
    language: getElementText(packageFile.xml, "dc:language"),
  };
}

function findSupplementalImagePaths(
  files: Record<string, Uint8Array>,
  packageFilename: string,
  packageXML: string
): string[] {
  const manifest = new Map<string, string>();
  for (const itemTag of packageXML.match(/<item\b[^>]*>/gi) || []) {
    const id = getAttribute(itemTag, "id");
    const href = getAttribute(itemTag, "href");
    if (id && href) {
      manifest.set(id, href);
    }
  }

  const packageDirectory = path.posix.dirname(packageFilename);
  const documentPaths: string[] = [];
  for (const itemReference of packageXML.match(/<itemref\b[^>]*>/gi) || []) {
    if (!/linear=["']no["']/i.test(itemReference)) {
      continue;
    }
    const id = getAttribute(itemReference, "idref");
    let href: string | undefined;
    if (id) {
      href = manifest.get(id);
    }
    if (href) {
      documentPaths.push(path.posix.normalize(path.posix.join(packageDirectory, href)));
    }
  }

  const imagePaths = new Set<string>();
  for (const documentPath of documentPaths) {
    const documentData = files[documentPath];
    if (!documentData) {
      continue;
    }
    const document = new TextDecoder().decode(documentData);
    for (const imageTag of document.match(/<img\b[^>]*>/gi) || []) {
      const source = getAttribute(imageTag, "src");
      if (source) {
        imagePaths.add(
          path.posix.normalize(path.posix.join(path.posix.dirname(documentPath), source))
        );
      }
    }
  }
  return [...imagePaths].filter((imagePath) => files[imagePath]);
}

export async function extractSupplementalEpubAssets(
  paths: BookPaths
): Promise<SupplementalAsset[]> {
  let files: Record<string, Uint8Array>;
  try {
    files = await unzipArchive(paths.sourcePath);
  } catch {
    return [];
  }
  const packageFile = getPackageXML(files);
  if (!packageFile) {
    return [];
  }

  const imagePaths = findSupplementalImagePaths(files, packageFile.filename, packageFile.xml);
  const assets: SupplementalAsset[] = [];
  for (const [index, imagePath] of imagePaths.entries()) {
    const extension = path.extname(imagePath).toLowerCase() || ".bin";
    const filename = `front-matter-${String(index + 1).padStart(3, "0")}${extension}`;
    await fs.promises.writeFile(path.join(paths.assetsDirectory, filename), files[imagePath]);
    let label = `Front matter ${index + 1}`;
    if (index === 0) {
      label = "Book cover";
    }
    assets.push({
      markdownPath: `assets/${filename}`,
      label,
    });
  }
  return assets;
}

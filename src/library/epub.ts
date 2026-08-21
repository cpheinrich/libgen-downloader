import fs from "node:fs";
import { unzip } from "fflate";

interface EpubPackage {
  title?: string;
  authors?: string;
  publisher?: string;
  language?: string;
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

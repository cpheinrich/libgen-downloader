import fs from "node:fs";
import path from "node:path";
import type { BookPaths, CanonicalValidation } from "./types";

export async function validateCanonicalBook(paths: BookPaths): Promise<CanonicalValidation> {
  const issues: string[] = [];
  const markdown = await fs.promises.readFile(paths.markdownPath, "utf8");
  const words = markdown.split(/\s+/).filter(Boolean).length;
  const headings = (markdown.match(/^#{1,6}\s+.+$/gm) || []).length;
  const imageMatches = [...markdown.matchAll(/!\[[^\]]*]\((assets\/[^)]+)\)/g)];

  for (const imageMatch of imageMatches) {
    const relativePath = imageMatch[1];
    if (relativePath && !fs.existsSync(path.join(paths.bookDirectory, relativePath))) {
      issues.push(`Missing linked asset: ${relativePath}`);
    }
  }
  if (words < 20) {
    issues.push("Markdown output contains fewer than 20 words.");
  }
  if (headings === 0) {
    issues.push("Markdown output contains no headings.");
  }
  if (/<(?:html|body|script|iframe)\b/i.test(markdown)) {
    issues.push("Markdown output contains unwanted raw HTML.");
  }

  let assets = 0;
  try {
    const directoryEntries = await fs.promises.readdir(paths.assetsDirectory);
    assets = directoryEntries.length;
  } catch {
    issues.push("Assets directory is missing.");
  }

  return {
    valid: issues.length === 0,
    words,
    headings,
    images: imageMatches.length,
    assets,
    issues,
  };
}

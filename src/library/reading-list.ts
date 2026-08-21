import type { BookRequest } from "./types";

function stripMarkdownListMarker(line: string): string {
  return line.replace(/^\s*(?:[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/, "").trim();
}

function stripMarkdownLink(value: string): string {
  const linkMatch = value.match(/^\[([^\]]+)]\([^)]*\)$/);
  return linkMatch?.[1]?.trim() || value;
}

export function parseBookRequest(value: string): BookRequest | undefined {
  const sourceLine = stripMarkdownListMarker(value);
  if (!sourceLine || /^(?:#|>|```|---)/.test(sourceLine)) {
    return undefined;
  }

  const cleaned = stripMarkdownLink(sourceLine);
  const byMatch = cleaned.match(/^(.+?)\s+by\s+(.+)$/i);
  if (byMatch?.[1] && byMatch[2]) {
    return {
      query: byMatch[1].trim(),
      title: byMatch[1].trim(),
      author: byMatch[2].trim(),
      sourceLine,
    };
  }

  const dashMatch = cleaned.match(/^(.+?)\s+[—–]\s+(.+)$/);
  if (dashMatch?.[1] && dashMatch[2]) {
    return {
      query: dashMatch[1].trim(),
      title: dashMatch[1].trim(),
      author: dashMatch[2].trim(),
      sourceLine,
    };
  }

  return { query: cleaned, title: cleaned, sourceLine };
}

export function parseReadingList(markdown: string): BookRequest[] {
  const requests: BookRequest[] = [];
  const seen = new Set<string>();

  for (const line of markdown.split(/\r?\n/)) {
    const request = parseBookRequest(line);
    if (!request) {
      continue;
    }

    const key = `${request.query}\u0000${request.author || ""}`.toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    requests.push(request);
  }

  return requests;
}

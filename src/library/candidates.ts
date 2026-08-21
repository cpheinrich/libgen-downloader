import type { Entry } from "../api/models/entry";
import { getEntryMD5 } from "./naming";
import type { BookRequest, RankedCandidate } from "./types";

const FORMAT_SCORES: Record<string, number> = {
  epub: 50,
  pdf: 38,
  docx: 34,
  html: 32,
  htm: 32,
  mobi: 26,
  azw3: 26,
  fb2: 24,
  rtf: 20,
  txt: 18,
  djvu: 10,
};

function normalizeForComparison(value: string): string {
  return value
    .normalize("NFKD")
    .replaceAll(/\p{Mark}/gu, "")
    .toLowerCase()
    .replaceAll(/[^\p{Letter}\p{Number}]+/gu, " ")
    .trim();
}

function getTokens(value: string): Set<string> {
  return new Set(normalizeForComparison(value).split(/\s+/).filter(Boolean));
}

function getCoverage(expected: string, actual: string): number {
  const expectedTokens = getTokens(expected);
  const actualTokens = getTokens(actual);
  if (expectedTokens.size === 0) {
    return 0;
  }

  let matched = 0;
  for (const token of expectedTokens) {
    if (actualTokens.has(token)) {
      matched += 1;
    }
  }
  return matched / expectedTokens.size;
}

function getBestTitleCoverage(expected: string, title: string): number {
  let bestCoverage = getCoverage(expected, title);
  for (const segment of title.split(" / ")) {
    bestCoverage = Math.max(bestCoverage, getCoverage(expected, segment));
  }
  return bestCoverage;
}

function hasExactTitleSegment(expected: string, title: string): boolean {
  const normalizedExpected = normalizeForComparison(expected);
  return title
    .split(" / ")
    .map((segment) => normalizeForComparison(segment))
    .includes(normalizedExpected);
}

function scoreCandidate(entry: Entry, request: BookRequest): RankedCandidate | undefined {
  const md5 = getEntryMD5(entry);
  if (!md5) {
    return undefined;
  }

  const reasons: string[] = [];
  let score = 0;
  const expectedTitle = request.title || request.query;
  const normalizedExpectedTitle = normalizeForComparison(expectedTitle);
  const normalizedTitle = normalizeForComparison(entry.title);
  const titleCoverage = getBestTitleCoverage(expectedTitle, entry.title);

  if (
    normalizedExpectedTitle === normalizedTitle ||
    hasExactTitleSegment(expectedTitle, entry.title)
  ) {
    score += 140;
    reasons.push("exact title match");
  } else {
    score += Math.round(titleCoverage * 100);
    if (titleCoverage >= 0.8) {
      reasons.push("strong title match");
    }
  }

  if (titleCoverage < 0.5) {
    score -= 100;
  }

  if (request.author) {
    const authorCoverage = getCoverage(request.author, entry.authors);
    score += Math.round(authorCoverage * 70);
    if (authorCoverage >= 0.8) {
      reasons.push("author match");
    }
    if (authorCoverage < 0.5) {
      score -= 50;
    }
  }

  const extension = entry.extension.toLowerCase();
  const formatScore = FORMAT_SCORES[extension] || 0;
  score += formatScore;
  if (formatScore > 0) {
    reasons.push(`${extension} conversion profile`);
  }

  if (/^english$/i.test(entry.language)) {
    score += 20;
    reasons.push("English language");
  }
  if (entry.pages && Number.parseInt(entry.pages, 10) > 0) {
    score += 5;
  }
  if (entry.publisher) {
    score += 3;
  }
  if (/^\d{4}$/.test(entry.year)) {
    score += 3;
  }
  if (entry.size.trim() !== "") {
    score += 2;
  }

  return { entry, md5, score, reasons };
}

export function rankCandidates(entries: Entry[], request: BookRequest): RankedCandidate[] {
  const ranked: RankedCandidate[] = [];
  for (const entry of entries) {
    const candidate = scoreCandidate(entry, request);
    if (candidate) {
      ranked.push(candidate);
    }
  }

  ranked.sort((first, second) => second.score - first.score);
  return ranked;
}

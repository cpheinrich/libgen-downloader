import fs from "node:fs";
import type { SupplementalAsset } from "./epub";

function getNumberedHeading(block: string): { number: string; title: string } | undefined {
  const match = block.match(/^(\d{1,2})\\?\.\s+(.{1,140})$/);
  if (!match?.[1] || !match[2]) {
    return undefined;
  }
  return { number: match[1], title: match[2].replace(/\.$/, "").trim() };
}

function isMarkdownStructure(block: string): boolean {
  return /^(?:#{1,6}\s|[-*+]\s|!\[|```|---$)/.test(block);
}

function shouldJoinPageBreak(previous: string, current: string): boolean {
  if (isMarkdownStructure(previous) || isMarkdownStructure(current)) {
    return false;
  }
  if (!/^['“‘(]*[a-z]/.test(current)) {
    return false;
  }
  return !/[.!?…:;”’"')\]]$/.test(previous);
}

function joinPageBreakParagraphs(blocks: string[]): string[] {
  const joined: string[] = [];
  for (const block of blocks) {
    const previous = joined.at(-1);
    if (previous && shouldJoinPageBreak(previous, block)) {
      let separator = " ";
      if (previous.endsWith("-")) {
        separator = "";
      }
      joined[joined.length - 1] = previous + separator + block;
    } else {
      joined.push(block);
    }
  }
  return joined;
}

export async function normalizeBookMarkdown(
  markdownPath: string,
  title: string,
  supplementalAssets: SupplementalAsset[] = []
): Promise<void> {
  const markdown = await fs.promises.readFile(markdownPath, "utf8");
  const blocks = markdown.replaceAll("\r\n", "\n").split(/\n{2,}/);
  const contentsIndex = blocks.findIndex((block) => /\bcontents\s*$/i.test(block.trim()));
  const seenChapterNumbers = new Set<string>();
  const normalizedBlocks: string[] = [`# ${title}`];

  for (const asset of supplementalAssets) {
    normalizedBlocks.push(`![${asset.label}](${asset.markdownPath})`);
  }

  for (const [index, originalBlock] of blocks.entries()) {
    const block = originalBlock.trim();
    if (!block || /^<span\b[^>]*><\/span>$/i.test(block)) {
      continue;
    }

    if (index === contentsIndex) {
      const beforeContents = block.replace(/\bcontents\s*$/i, "").trim();
      if (beforeContents) {
        normalizedBlocks.push(beforeContents);
      }
      normalizedBlocks.push("## Contents");
      continue;
    }

    const numbered = getNumberedHeading(block);
    if (numbered && contentsIndex !== -1 && index > contentsIndex) {
      if (seenChapterNumbers.has(numbered.number)) {
        normalizedBlocks.push(`## ${numbered.number}. ${numbered.title}`);
      } else {
        seenChapterNumbers.add(numbered.number);
        normalizedBlocks.push(`- ${numbered.number}. ${numbered.title}`);
      }
      continue;
    }

    if (/^(?:preface|introduction|afterword|epilogue)\b.{0,100}$/i.test(block)) {
      normalizedBlocks.push(`## ${block.replace(/\.$/, "")}`);
      continue;
    }

    normalizedBlocks.push(block);
  }

  const joinedBlocks = joinPageBreakParagraphs(normalizedBlocks);
  await fs.promises.writeFile(markdownPath, `${joinedBlocks.join("\n\n")}\n`);
}

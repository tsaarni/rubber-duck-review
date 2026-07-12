import * as vscode from 'vscode';

/**
 * Build a trusted, theme-aware MarkdownString from plain text.
 */
export function asMarkdown(body: string): vscode.MarkdownString {
  const md = new vscode.MarkdownString(body);
  md.isTrusted = true;
  md.supportThemeIcons = true;
  return md;
}

// ── Suggestion blocks ──

const SUGGESTION_OPEN = '```suggestion\n';
const SUGGESTION_CLOSE = '```';

/**
 * Extract the content inside a ```suggestion code fence, if present.
 */
export function parseSuggestionBlock(body: string): string | undefined {
  const start = body.indexOf(SUGGESTION_OPEN);
  if (start === -1) {
    return;
  }
  const contentStart = start + SUGGESTION_OPEN.length;

  let searchFrom = contentStart;
  let end = -1;
  while (true) {
    const idx = body.indexOf(SUGGESTION_CLOSE, searchFrom);
    if (idx === -1) {
      break;
    }
    end = idx;
    searchFrom = idx + SUGGESTION_CLOSE.length;
  }

  if (end === -1) {
    return;
  }
  return body.slice(contentStart, end);
}

/**
 * Build a ```suggestion code fence containing the given text.
 * Trims trailing newlines to avoid extra blank lines in the suggestion.
 */
export function buildSuggestionBlock(selectedText: string): string {
  return `${SUGGESTION_OPEN}${selectedText.trimEnd()}\n${SUGGESTION_CLOSE}`;
}

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { getCurrentAuthor } from './author';
import type { CommitInfo } from './git';
import { logger } from './logger';

// ──────────────────────────────────────────────
// Types  (mirror reviews-schema.json)
// ──────────────────────────────────────────────

export interface AuthorInfo {
  name: string;
  email?: string;
}

export interface ReviewComment {
  id: string;
  path: string;
  startLine?: number; // Required for LINE, omitted for FILE
  endLine?: number; // Required for LINE, omitted for FILE
  subjectType: 'LINE' | 'FILE';
  body: string;
  author?: AuthorInfo; // Author of this specific comment
  createdAt: string; // ISO 8601
}

export interface Review {
  id: string;
  baseCommit: CommitInfo | null;
  headCommit: CommitInfo | null;
  hasUncommittedChanges: boolean;
  createdAt: string;
  comments: ReviewComment[];
}

interface ReviewsFile {
  version: 1;
  author?: AuthorInfo;
  reviews: Review[];
}

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

function nowISO(): string {
  return new Date().toISOString();
}

function newUUID(): string {
  return crypto.randomUUID();
}

// ──────────────────────────────────────────────
// Store
// ──────────────────────────────────────────────

export class ReviewStore {
  private readonly filePath: string;
  private data: ReviewsFile;

  private constructor(filePath: string, data: ReviewsFile) {
    this.filePath = filePath;
    this.data = data;
  }

  /** Load (or create) the reviews file at the given workspace root. */
  static async load(
    workspaceRoot: vscode.Uri,
    customPath?: string
  ): Promise<ReviewStore> {
    const relativePath = customPath ?? '.vscode/reviews.json';
    const filePath = vscode.Uri.joinPath(workspaceRoot, relativePath).fsPath;

    let data: ReviewsFile;
    try {
      const raw = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
      const decoded = new TextDecoder().decode(raw);
      data = JSON.parse(decoded) as ReviewsFile;
    } catch (err) {
      // File does not exist — start fresh
      if (
        err instanceof vscode.FileSystemError &&
        err.code === 'FileNotFound'
      ) {
        logger.debug('Reviews file does not exist yet, starting fresh');
        data = { version: 1, reviews: [] };
        return new ReviewStore(filePath, data);
      }

      // File exists but is malformed — log error, start fresh, but do NOT overwrite
      logger.error(
        `Failed to parse reviews file ${filePath}: ${err}. Starting with empty reviews. The file will not be overwritten until the next mutation.`
      );
      vscode.window.showErrorMessage(
        `Rubber Duck Review: Failed to load reviews file (${filePath}). Starting with empty reviews. Check the file for syntax errors.`
      );
      data = { version: 1, reviews: [] };
      return new ReviewStore(filePath, data);
    }

    // Version check
    if (data.version !== 1) {
      logger.error(
        `Reviews file has unsupported version ${data.version}. Expected 1. Starting with empty reviews.`
      );
      vscode.window.showErrorMessage(
        `Rubber Duck Review: Reviews file has unsupported version ${data.version}. The file may have been created by a newer version of the extension.`
      );
      data = { version: 1, reviews: [] };
      return new ReviewStore(filePath, data);
    }

    return new ReviewStore(filePath, data);
  }

  // ── Query methods ──

  getReviews(): Review[] {
    return this.data.reviews;
  }

  getReview(id: string): Review | undefined {
    return this.data.reviews.find((r) => r.id === id);
  }

  findByBase(baseCommit: string): Review | undefined {
    return this.data.reviews.find((r) => r.baseCommit?.id === baseCommit);
  }

  // ── Mutation methods ──

  async createReview(
    baseCommit: CommitInfo | null,
    headCommit: CommitInfo | null,
    hasUncommittedChanges: boolean,
    author?: AuthorInfo
  ): Promise<Review> {
    const review: Review = {
      id: newUUID(),
      baseCommit,
      headCommit,
      hasUncommittedChanges,
      createdAt: nowISO(),
      comments: [],
    };

    this.data.reviews.push(review);
    if (author) {
      this.data.author = author;
    }
    await this.save();
    return review;
  }

  async deleteReview(id: string): Promise<void> {
    const idx = this.data.reviews.findIndex((r) => r.id === id);
    if (idx !== -1) {
      this.data.reviews.splice(idx, 1);
      await this.save();
    }
  }

  async deleteAllReviews(): Promise<void> {
    this.data.reviews = [];
    await this.save();
  }

  async addComment(
    reviewId: string,
    filePath: string,
    startLine: number,
    endLine: number,
    subjectType: 'LINE' | 'FILE',
    body: string,
    author?: AuthorInfo
  ): Promise<ReviewComment> {
    const review = this.getReview(reviewId);
    if (!review) {
      throw new Error(`Review ${reviewId} not found`);
    }

    // Only one file-level comment per file
    if (subjectType === 'FILE') {
      const existing = review.comments.find(
        (c) => c.subjectType === 'FILE' && c.path === filePath
      );
      if (existing) {
        throw new Error(
          `A file-level comment already exists on ${filePath}. Delete it first or edit the existing one.`
        );
      }
    }

    const comment: ReviewComment = {
      id: newUUID(),
      path: filePath,
      subjectType,
      body,
      author,
      createdAt: nowISO(),
      ...(subjectType === 'LINE' ? { startLine, endLine } : {}),
    };

    review.comments.push(comment);
    await this.save();
    return comment;
  }

  async editComment(
    reviewId: string,
    commentId: string,
    body: string
  ): Promise<void> {
    const comment = this.findComment(reviewId, commentId);
    if (!comment) {
      throw new Error(`Comment ${commentId} not found in review ${reviewId}`);
    }
    comment.body = body;
    await this.save();
  }

  async deleteComment(reviewId: string, commentId: string): Promise<void> {
    const review = this.getReview(reviewId);
    if (!review) {
      return;
    }
    const idx = review.comments.findIndex((c) => c.id === commentId);
    if (idx !== -1) {
      review.comments.splice(idx, 1);
      await this.save();
    }
  }

  /**
   * Generates a Markdown export of the review.
   */
  async exportMarkdown(
    reviewId: string,
    workspaceRoot: vscode.Uri
  ): Promise<string> {
    const review = this.getReview(reviewId);
    if (!review) {
      throw new Error(`Review ${reviewId} not found`);
    }

    const lines: string[] = [];

    // Header
    const folderName = path.basename(workspaceRoot.fsPath);
    lines.push(`# Code Review: ${folderName}`);
    lines.push('');

    // Metadata
    const { name: userName, email: userEmail } = getCurrentAuthor();
    const authorStr =
      userName || userEmail
        ? `**Author:** ${userName}${userEmail ? ` <${userEmail}>` : ''}`
        : '';
    if (authorStr) {
      lines.push(authorStr);
    }
    lines.push(`**Date:** \`${review.createdAt}\``);

    if (review.baseCommit) {
      lines.push(
        `**Base:** \`${review.baseCommit.id}\` "${review.baseCommit.message}"`
      );
    }
    if (review.headCommit) {
      lines.push(
        `**Head:** \`${review.headCommit.id}\` "${review.headCommit.message}"${review.hasUncommittedChanges ? ' (with uncommitted changes)' : ''}`
      );
    }
    lines.push('');

    // Comments
    for (const comment of review.comments) {
      lines.push('---', '');
      const displayPath = comment.path.replace(/\\/g, '/');

      if (comment.subjectType === 'FILE') {
        lines.push(`## ${displayPath} (file-level comment)`);
      } else {
        lines.push(
          `## ${displayPath} (lines ${comment.startLine}-${comment.endLine})`
        );
      }
      lines.push(
        `<!-- comment id ${comment.id}, created at ${comment.createdAt} -->`
      );
      lines.push('');

      // Code snippet (only for LINE comments)
      if (
        comment.subjectType === 'LINE' &&
        comment.startLine != null &&
        comment.endLine != null
      ) {
        const fileUri = vscode.Uri.joinPath(workspaceRoot, comment.path);
        const snippet = await readSnippet(
          fileUri,
          comment.startLine,
          comment.endLine
        );
        if (snippet === null) {
          lines.push('*(source file not found)*');
        } else {
          lines.push(`\`\`\`${snippet.languageId}`);
          lines.push(snippet.text);
          lines.push('```');
        }
        lines.push('');
      }

      // Comment body in blockquote — escape content that would break the blockquote structure
      const commentAuthor = comment.author?.name || userName;
      lines.push(`${commentAuthor} wrote:`);
      const escapedBody = escapeForBlockquote(comment.body);
      lines.push(`> ${escapedBody.replace(/\n/g, '\n> ')}`);
      lines.push('');
    }

    return lines.join('\n');
  }

  // ── Internal ──

  private findComment(
    reviewId: string,
    commentId: string
  ): ReviewComment | undefined {
    const review = this.getReview(reviewId);
    return review?.comments.find((c) => c.id === commentId);
  }

  /**
   * Atomic save: write to a temp file in the same directory, then rename.
   * This prevents partial writes from corrupting the reviews file.
   */
  private async save(): Promise<void> {
    const raw = new TextEncoder().encode(JSON.stringify(this.data, null, 2));

    // Ensure parent directory exists
    const dir = path.dirname(this.filePath);
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (err) {
      logger.error(`Failed to create directory ${dir}: ${err}`);
    }

    // Write to temp file, then atomically rename
    const tmpPath = `${this.filePath}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(tmpPath, raw);
      fs.renameSync(tmpPath, this.filePath);
    } catch (err) {
      logger.error(`Failed to save reviews file ${this.filePath}: ${err}`);
      // Clean up temp file if it exists
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        // ignore cleanup failure
      }
      throw err;
    }
  }
}

// ── Snippet reader ──

async function readSnippet(
  fileUri: vscode.Uri,
  startLine: number,
  endLine: number
): Promise<{ text: string; languageId: string } | null> {
  let doc: vscode.TextDocument;
  try {
    doc = await vscode.workspace.openTextDocument(fileUri);
  } catch {
    return null;
  }

  const snippetLines: string[] = [];
  for (let i = startLine; i <= endLine; i++) {
    const lineText = doc.lineAt(i - 1).text; // lineAt is 0-based
    snippetLines.push(lineText);
  }
  return { text: snippetLines.join('\n'), languageId: doc.languageId };
}

// ── Markdown escaping ──

/**
 * Escape content for embedding in a markdown blockquote.
 * Prevents code fences and headings from breaking out of the blockquote.
 */
function escapeForBlockquote(body: string): string {
  return body
    .replace(/^```/gm, '\\`\\`\\`') // escape code fences
    .replace(/^#/gm, '\\#') // escape headings
    .replace(/^>/gm, '\\>'); // escape nested blockquotes
}

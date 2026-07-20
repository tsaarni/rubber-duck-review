// Persistent storage for reviews and comments, backed by a JSON file.

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { CommitInfo } from './git';
import { logger } from './logger';

// Types (mirrors reviews-schema.json)

export interface AuthorInfo {
  name: string;
  email?: string;
}

export interface ReviewSymbolInfo {
  name: string;
  kind: string;
  containerName?: string;
  detail?: string;
  startLine?: number;
  endLine?: number;
}

export interface ReviewComment {
  id: string;
  path: string;
  startLine?: number; // Required for LINE, omitted for FILE
  endLine?: number; // Required for LINE, omitted for FILE
  startColumn?: number;
  endColumn?: number;
  subjectType: 'LINE' | 'FILE';
  languageId?: string;
  body: string;
  snippet?: string;
  symbol?: ReviewSymbolInfo;
  createdAt: string;
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
  reviews: Review[];
}

// Helpers

function nowISO(): string {
  return new Date().toISOString();
}

function newUUID(): string {
  return crypto.randomUUID();
}

// Store

export class ReviewStore {
  private readonly filePath: string;
  private readonly data: ReviewsFile;

  get reviewsFilePath(): string {
    return this.filePath;
  }

  private constructor(filePath: string, data: ReviewsFile) {
    this.filePath = filePath;
    this.data = data;
  }

  // Load (or create) the reviews file at the given workspace root.
  static async load(
    workspaceRoot: vscode.Uri,
    customPath: string = '.vscode/reviews.json'
  ): Promise<ReviewStore> {
    const filePath = vscode.Uri.joinPath(workspaceRoot, customPath).fsPath;

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

  // Query methods

  getReviews(): Review[] {
    return this.data.reviews;
  }

  getReview(id: string): Review | undefined {
    return this.data.reviews.find((r) => r.id === id);
  }

  findByBase(baseCommit: string): Review | undefined {
    return this.data.reviews.find((r) => r.baseCommit?.id === baseCommit);
  }

  // Mutation methods

  async createReview(
    baseCommit: CommitInfo | null,
    headCommit: CommitInfo | null,
    hasUncommittedChanges: boolean
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
    snippet?: string,
    options?: {
      startColumn?: number;
      endColumn?: number;
      languageId?: string;
      symbol?: ReviewSymbolInfo;
    }
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
      createdAt: nowISO(),
      languageId: options?.languageId,
      symbol: options?.symbol,
      ...(subjectType === 'LINE'
        ? {
            startLine,
            endLine,
            startColumn: options?.startColumn,
            endColumn: options?.endColumn,
            snippet,
          }
        : {}),
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
    if (!review) return;
    const idx = review.comments.findIndex((c) => c.id === commentId);
    if (idx !== -1) {
      review.comments.splice(idx, 1);
      await this.save();
    }
  }

  // Generate a Markdown export of the review.
  async exportMarkdown(
    reviewId: string,
    workspaceRoot: vscode.Uri,
    author?: AuthorInfo
  ): Promise<string> {
    const review = this.getReview(reviewId);
    if (!review) {
      throw new Error(`Review ${reviewId} not found`);
    }

    const lines: string[] = [];

    const folderName = path.basename(workspaceRoot.fsPath);
    lines.push(`# Code Review: ${folderName}`, '');

    const userName = author?.name ?? 'Unknown';
    const userEmail = author?.email;
    lines.push(
      `**Author:** ${userName}${userEmail ? ` <${userEmail}>` : ''}`,
      `**Date:** ${formatExportDate(review.createdAt)}`
    );

    if (review.baseCommit) {
      const shortSha = review.baseCommit.id.slice(0, 7);
      lines.push(`**Base:** \`${shortSha}\` ("${review.baseCommit.message}")`);
    }
    if (review.headCommit) {
      const shortSha = review.headCommit.id.slice(0, 7);
      const uncommitted = review.hasUncommittedChanges
        ? ' (with uncommitted changes)'
        : '';
      lines.push(
        `**Head:** \`${shortSha}\` ("${review.headCommit.message}"${uncommitted})`
      );
    }
    lines.push('');

    lines.push(
      '> **Note:** Line numbers may differ from the current file.',
      ''
    );

    for (const comment of review.comments) {
      lines.push('---', '');
      lines.push(`## ${formatLocation(comment)}`);

      lines.push(
        `<!-- comment id ${comment.id}, created at ${comment.createdAt} -->`,
        ''
      );

      // Code snippet for LINE comments (stored at creation time; line numbers are hints only)
      if (comment.subjectType === 'LINE' && comment.snippet) {
        const lang = comment.languageId ?? '';
        lines.push(`\`\`\`${lang}`, comment.snippet, '```', '');
      }

      // Comment body in blockquote
      const commentAuthor = author?.name || 'Unknown';
      const escapedBody = escapeForBlockquote(comment.body);
      lines.push(
        `${commentAuthor} wrote:`,
        `> ${escapedBody.replaceAll('\n', '\n> ')}`,
        ''
      );
    }

    return lines.join('\n');
  }

  // Internal

  private findComment(
    reviewId: string,
    commentId: string
  ): ReviewComment | undefined {
    const review = this.getReview(reviewId);
    return review?.comments.find((c) => c.id === commentId);
  }

  // Delete the reviews file from disk (used when no reviews remain).
  private async deleteFile(): Promise<void> {
    try {
      logger.debug(`Deleting reviews file ${this.filePath} (no reviews left)`);
      fs.unlinkSync(this.filePath);
    } catch (err) {
      if (
        err &&
        typeof err === 'object' &&
        'code' in err &&
        (err as { code?: unknown }).code !== 'ENOENT'
      ) {
        logger.error(`Failed to delete reviews file ${this.filePath}: ${err}`);
        throw err;
      }
      // File did not exist — nothing to do (already "deleted")
    }
  }

  // Atomic save: write to a temp file then rename. Prevents corruption from partial writes.
  // If there are no reviews left, the file is deleted from disk instead.
  private async save(): Promise<void> {
    if (this.data.reviews.length === 0) {
      await this.deleteFile();
      return;
    }

    const raw = new TextEncoder().encode(
      `${JSON.stringify(this.data, null, 2)}\n`
    );

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
      logger.debug(`Saving reviews file to ${this.filePath}`);
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

// Format ISO date string for markdown export header.
function formatExportDate(isoDate: string): string {
  return isoDate
    .replace('T', ' ')
    .replace(/\.\d+Z$/, ' UTC')
    .replace(/Z$/, ' UTC');
}

// Format location (filename, line/range, symbol) in standard grep/git format.
function formatLocation(comment: ReviewComment): string {
  const displayPath = comment.path.replace(/\\/g, '/');

  let location = displayPath;
  if (comment.subjectType === 'LINE' && comment.startLine !== undefined) {
    const lineStr =
      comment.endLine === undefined || comment.startLine === comment.endLine
        ? `${comment.startLine}`
        : `${comment.startLine}-${comment.endLine}`;
    location = `${displayPath}:${lineStr}`;
  }

  if (comment.symbol) {
    location = `${location} @@ ${formatSymbol(comment.symbol)}`;
  }

  return location;
}

// Format a symbol e.g. Container.methodName.
function formatSymbol(symbol: ReviewSymbolInfo): string {
  const symbolPath = symbol.containerName
    ? `${symbol.containerName}.${symbol.name}`
    : symbol.name;

  if (symbol.detail) {
    if (symbol.detail.startsWith('(')) {
      return `${symbolPath}${symbol.detail}`;
    }
    if (symbol.detail.includes(symbol.name)) {
      return symbol.containerName
        ? `${symbol.containerName}.${symbol.detail}`
        : symbol.detail;
    }
    return `${symbolPath} ${symbol.detail}`;
  }

  return symbolPath;
}

// Escape content for embedding in a markdown blockquote.
function escapeForBlockquote(body: string): string {
  const backslash = String.raw`\\`[0];
  return body
    .replace(/^```/gm, `${backslash}\`${backslash}\`${backslash}\``)
    .replace(/^#/gm, `${backslash}#`)
    .replace(/^>/gm, `${backslash}>`);
}

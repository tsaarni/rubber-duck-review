// Per-workspace-folder review lifecycle: start, stop, switch, export, and comment delegation.

import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ReviewCommentImpl } from './comment-model';
import { ReviewCommentController } from './controller';
import type { CommitInfo, GitContext } from './git';
import { logger } from './logger';
import type { AuthorInfo, ReviewStore } from './store';

export class ReviewManager implements vscode.Disposable {
  private readonly store: ReviewStore;
  private readonly workspaceRoot: vscode.Uri;
  private readonly gitContext: GitContext | undefined;
  private controller: ReviewCommentController | undefined;
  private readonly onStateChange: () => void;
  private _author: AuthorInfo | undefined;

  /** Public so extension.ts can read aggregate state. */
  public activeReviewId: string | undefined;

  constructor(
    store: ReviewStore,
    workspaceRoot: vscode.Uri,
    gitContext: GitContext | undefined,
    onStateChange: () => void
  ) {
    this.store = store;
    this.workspaceRoot = workspaceRoot;
    this.gitContext = gitContext;
    this.onStateChange = onStateChange;
  }

  get isReviewActive(): boolean {
    return this.activeReviewId !== undefined;
  }

  get folderName(): string {
    return this.workspaceRoot.fsPath.split(/[/\\]/).pop() ?? 'workspace';
  }

  get commentCount(): number {
    if (!this.activeReviewId) {
      return 0;
    }
    const review = this.store.getReview(this.activeReviewId);
    return review?.comments.length ?? 0;
  }

  // Review lifecycle

  // Start or resume a review. Auto-resumes a review matching the current base commit, or shows a quick pick.
  async startReview(): Promise<void> {
    const commitCtx = await this.determineCommitContext();

    if (commitCtx?.baseCommit) {
      const existing = this.store.findByBase(commitCtx.baseCommit.id);
      if (existing) {
        await this.activateReview(existing.id);
        return;
      }
    }

    const reviews = this.store
      .getReviews()
      .filter((r) => r.comments.length > 0);

    if (reviews.length === 0) {
      await this.createNewReview(commitCtx);
      return;
    }

    const items: vscode.QuickPickItem[] = [
      { label: '$(plus) Start new review', description: '' },
      ...reviews.map((r) => ({
        label: `Review ${r.id.slice(0, 8)}`,
        description: `${r.comments.length} comments — ${r.createdAt}`,
        detail: r.baseCommit
          ? `base: ${r.baseCommit.id.slice(0, 8)} ${r.baseCommit.message}`
          : 'no git context',
      })),
    ];

    const pick = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select a review or start a new one',
    });

    if (!pick) return;

    if (pick.label.startsWith('$(plus)')) {
      await this.createNewReview(commitCtx);
    } else {
      // skip the "new review" item
      const idx = items.indexOf(pick) - 1;
      const selected = reviews[idx];
      if (selected) {
        await this.activateReview(selected.id);
      }
    }
  }

  // Create a new review.
  async newReview(): Promise<void> {
    const commitCtx = await this.determineCommitContext();
    await this.createNewReview(commitCtx);
  }

  // Show a quick pick of all reviews and switch to the selected one.
  async switchReview(): Promise<void> {
    const reviews = this.store.getReviews();

    if (reviews.length === 0) {
      vscode.window.showInformationMessage(
        'No reviews found for this workspace folder.'
      );
      return;
    }

    const items = reviews.map((r) => ({
      label: `Review ${r.id.slice(0, 8)}`,
      description: `${r.comments.length} comments — ${r.createdAt}`,
      detail: r.baseCommit
        ? `base: ${r.baseCommit.id.slice(0, 8)} ${r.baseCommit.message}`
        : 'no git context',
      id: r.id,
    }));

    const pick = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select a review to load',
    });

    if (!pick) return;

    this.cleanupReview();
    await this.activateReview(pick.id);
  }

  // Stop the active review. Comments are preserved.
  stopReview(): void {
    if (!this.activeReviewId) return;
    this.cleanupReview();
    vscode.window.showInformationMessage('Review stopped.');
  }

  // Relative path to reviews file e.g. projectdir/.vscode/reviews.json
  getRelativeReviewsPath(): string {
    const parentDir = path.dirname(this.workspaceRoot.fsPath);
    return path
      .relative(parentDir, this.store.reviewsFilePath)
      .replace(/\\/g, '/');
  }

  // Delete the active review after confirmation.
  async clearReview(): Promise<void> {
    if (!this.activeReviewId) {
      vscode.window.showInformationMessage('No active review to clear.');
      return;
    }

    const targetPath = this.getRelativeReviewsPath();
    const confirm = await vscode.window.showWarningMessage(
      `Delete the active review in ${targetPath}?`,
      { modal: true },
      'Delete'
    );

    if (confirm !== 'Delete') return;

    const id = this.activeReviewId;
    this.cleanupReview();
    await this.store.deleteReview(id);
    vscode.window.showInformationMessage('Review deleted.');
  }

  // Delete all reviews for this folder after confirmation.
  async deleteAllReviews(): Promise<void> {
    const targetPath = this.getRelativeReviewsPath();
    const confirm = await vscode.window.showWarningMessage(
      `Delete ALL reviews in ${targetPath}?`,
      { modal: true },
      'Delete All'
    );

    if (confirm !== 'Delete All') return;

    this.cleanupReview();
    await this.store.deleteAllReviews();
    vscode.window.showInformationMessage('All reviews deleted.');
  }

  // Comment delegation

  async createComment(
    thread: vscode.CommentThread,
    input: string
  ): Promise<void> {
    await this.controller?.createComment(thread, input);
  }

  async createFileComment(uri?: vscode.Uri): Promise<void> {
    const targetUri = uri ?? vscode.window.activeTextEditor?.document.uri;
    if (!targetUri) {
      vscode.window.showErrorMessage('No active file to comment on.');
      return;
    }

    if (!this.isReviewActive) {
      const start = await vscode.window.showInformationMessage(
        'No active review. Start a review to add a comment?',
        'Start Review'
      );
      if (start === 'Start Review') {
        await this.startReview();
      }
      if (!this.isReviewActive) return;
    }

    await this.controller?.createFileComment(targetUri);
  }

  async createSuggestion(
    uri: vscode.Uri,
    range: vscode.Range,
    selectedText: string
  ): Promise<void> {
    await this.controller?.createSuggestion(uri, range, selectedText);
  }

  editComment(comment: ReviewCommentImpl): void {
    this.controller?.editComment(comment);
  }

  async deleteComment(comment: ReviewCommentImpl): Promise<void> {
    await this.controller?.deleteComment(comment);
  }

  async saveComment(comment: ReviewCommentImpl): Promise<void> {
    await this.controller?.saveComment(comment);
  }

  cancelEditComment(comment: ReviewCommentImpl): void {
    this.controller?.cancelEditComment(comment);
  }

  // Export the active review as Markdown.
  async exportMarkdown(): Promise<void> {
    if (!this.activeReviewId) {
      vscode.window.showInformationMessage('No active review to export.');
      return;
    }

    const author = await this.resolveAuthor();

    let markdown: string;
    try {
      markdown = await this.store.exportMarkdown(
        this.activeReviewId,
        this.workspaceRoot,
        author
      );
    } catch (err) {
      logger.error(`Export failed: ${err}`);
      vscode.window.showErrorMessage(
        'Failed to export review. See output for details.'
      );
      return;
    }

    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.joinPath(this.workspaceRoot, 'review-export.md'),
      filters: { Markdown: ['md'] },
    });

    if (!uri) return;

    try {
      await vscode.workspace.fs.writeFile(
        uri,
        new TextEncoder().encode(markdown)
      );
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc);
      vscode.window.showInformationMessage('Review exported.');
    } catch (err) {
      logger.error(`Failed to write export file: ${err}`);
      vscode.window.showErrorMessage('Failed to save exported review.');
    }
  }

  // Internal

  // Resolve author from git config. Falls back to OS username, then environment variables. Cached after first call.
  private async resolveAuthor(): Promise<AuthorInfo> {
    if (this._author) return this._author;

    if (this.gitContext) {
      try {
        const gitAuthor = await this.gitContext.getAuthor();
        if (gitAuthor.name) {
          this._author = gitAuthor;
          return this._author;
        }
      } catch {}
    }

    try {
      const username = os.userInfo().username;
      if (username) {
        this._author = { name: username };
        return this._author;
      }
    } catch {}

    // Last resort: environment variables
    this._author = {
      name:
        process.env.USER ??
        process.env.LOGNAME ??
        process.env.USERNAME ??
        'Unknown',
    };
    return this._author;
  }

  private async determineCommitContext(): Promise<{
    baseCommit: CommitInfo | null;
    headCommit: CommitInfo | null;
    isDirty: boolean;
  }> {
    if (!this.gitContext) {
      return { baseCommit: null, headCommit: null, isDirty: false };
    }

    try {
      const isDirty = await this.gitContext.isDirty();
      let headCommit: CommitInfo | null = null;
      let baseCommit: CommitInfo | null = null;

      try {
        headCommit = await this.gitContext.getCommit('HEAD');
      } catch {
        // No commits yet
      }

      if (headCommit) {
        const defaultBranch = await this.gitContext.getDefaultBranch();
        if (defaultBranch) {
          const mergeBase = await this.gitContext.getMergeBase(
            headCommit.id,
            defaultBranch
          );
          if (mergeBase) {
            try {
              baseCommit = await this.gitContext.getCommit(mergeBase);
            } catch {
              baseCommit = { id: mergeBase, message: '' };
            }
          } else {
            baseCommit = headCommit;
          }
        } else {
          // No remote — use HEAD as base. Working-tree changes are tracked via isDirty.
          baseCommit = headCommit;
        }
      }

      return { baseCommit, headCommit, isDirty };
    } catch (err) {
      logger.warn(`Failed to determine git context: ${err}`);
      return { baseCommit: null, headCommit: null, isDirty: false };
    }
  }

  private async createNewReview(commitCtx: {
    baseCommit: CommitInfo | null;
    headCommit: CommitInfo | null;
    isDirty: boolean;
  }): Promise<void> {
    try {
      const review = await this.store.createReview(
        commitCtx.baseCommit,
        commitCtx.headCommit,
        commitCtx.isDirty
      );
      await this.activateReview(review.id);
      vscode.window.showInformationMessage('New review started.');
    } catch (err) {
      logger.error(`Failed to create review: ${err}`);
      vscode.window.showErrorMessage(
        'Failed to create review. See output for details.'
      );
    }
  }

  private async activateReview(reviewId: string): Promise<void> {
    this.cleanupReview();

    const author = await this.resolveAuthor();
    const controller = new ReviewCommentController(
      this.store,
      reviewId,
      this.workspaceRoot,
      author
    );

    await controller.initialize();
    this.controller = controller;
    this.activeReviewId = reviewId;
    this.onStateChange();

    logger.info(`Review ${reviewId} activated for ${this.folderName}`);
  }

  private cleanupReview(): void {
    if (this.controller) {
      this.controller.dispose();
      this.controller = undefined;
    }
    this.activeReviewId = undefined;
    this.onStateChange();
  }

  dispose(): void {
    this.cleanupReview();
  }
}

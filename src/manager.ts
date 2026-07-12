import * as vscode from 'vscode';
import { getCurrentAuthor } from './author';
import type { ReviewCommentImpl } from './comment';
import { ReviewCommentController } from './controller';
import type { CommitInfo, GitContext } from './git';
import { logger } from './logger';
import type { ReviewStore } from './store';

/**
 * Per-workspace-folder review lifecycle manager.
 */
export class ReviewManager implements vscode.Disposable {
  private readonly store: ReviewStore;
  private readonly workspaceRoot: vscode.Uri;
  private readonly gitContext: GitContext | undefined;
  private controller: ReviewCommentController | undefined;
  private readonly onStateChange: () => void;

  /** Public so extension.ts can query aggregate state. */
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

  // ────────────────────────────────────────────
  // Review lifecycle
  // ────────────────────────────────────────────

  /**
   * Starts (or resumes) a review for this workspace folder.
   * Determines commit context, auto-resumes matching review,
   * or shows a quick pick.
   */
  async startReview(): Promise<void> {
    const commitCtx = await this.determineCommitContext();

    // Check if a review already exists with the same base
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
      // No existing reviews — create a new one
      await this.createNewReview(commitCtx);
      return;
    }

    // Show quick pick: new review or pick existing
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

    if (!pick) {
      return; // user cancelled
    }

    if (pick.label.startsWith('$(plus)')) {
      await this.createNewReview(commitCtx);
    } else {
      // Find the review by matching the detail (base commit)
      const idx = items.indexOf(pick) - 1; // skip the "new review" item
      const selected = reviews[idx];
      if (selected) {
        await this.activateReview(selected.id);
      }
    }
  }

  /**
   * Force-create a new review, regardless of existing ones.
   */
  async newReview(): Promise<void> {
    const commitCtx = await this.determineCommitContext();
    await this.createNewReview(commitCtx);
  }

  /**
   * Show a quick pick of all reviews and switch to the selected one.
   */
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

    if (!pick) {
      return;
    }

    this.cleanupReview();
    await this.activateReview(pick.id);
  }

  /**
   * Stop the active review without deleting it.
   * Comments are preserved and can be resumed later.
   */
  stopReview(): void {
    if (!this.activeReviewId) {
      return;
    }
    this.cleanupReview();
    vscode.window.showInformationMessage('Review stopped.');
  }

  /**
   * Delete the active review after confirmation.
   */
  async clearReview(): Promise<void> {
    if (!this.activeReviewId) {
      vscode.window.showInformationMessage('No active review to clear.');
      return;
    }

    const confirm = await vscode.window.showWarningMessage(
      `Delete the active review for "${this.folderName}"?`,
      { modal: true },
      'Delete'
    );

    if (confirm !== 'Delete') {
      return;
    }

    const id = this.activeReviewId;
    this.cleanupReview();
    await this.store.deleteReview(id);
    vscode.window.showInformationMessage('Review deleted.');
  }

  /**
   * Delete all reviews for this folder after confirmation.
   */
  async deleteAllReviews(): Promise<void> {
    const confirm = await vscode.window.showWarningMessage(
      `Delete ALL reviews for "${this.folderName}"?`,
      { modal: true },
      'Delete All'
    );

    if (confirm !== 'Delete All') {
      return;
    }

    this.cleanupReview();
    await this.store.deleteAllReviews();
    vscode.window.showInformationMessage('All reviews deleted.');
  }

  // ────────────────────────────────────────────
  // Comment delegation to the active controller
  // ────────────────────────────────────────────

  async createComment(
    thread: vscode.CommentThread,
    input: string
  ): Promise<void> {
    await this.controller?.createComment(thread, input);
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

  /**
   * Export the active review as Markdown.
   */
  async exportMarkdown(): Promise<void> {
    if (!this.activeReviewId) {
      vscode.window.showInformationMessage('No active review to export.');
      return;
    }

    let markdown: string;
    try {
      markdown = await this.store.exportMarkdown(
        this.activeReviewId,
        this.workspaceRoot
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

    if (!uri) {
      return; // user cancelled
    }

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

  // ────────────────────────────────────────────
  // Internal
  // ────────────────────────────────────────────

  private async determineCommitContext(): Promise<{
    baseCommit: CommitInfo | null;
    headCommit: CommitInfo | null;
    isDirty: boolean;
  }> {
    if (!this.gitContext) {
      return {
        baseCommit: null,
        headCommit: null,
        isDirty: false,
      };
    }

    try {
      const isDirty = await this.gitContext.isDirty();
      const headRef = 'HEAD';
      let headCommit: CommitInfo | null = null;
      let baseCommit: CommitInfo | null = null;

      try {
        headCommit = await this.gitContext.getCommit(headRef);
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
          // No remote — use HEAD as base. The review captures the
          // current commit; working-tree changes are tracked via isDirty.
          baseCommit = headCommit;
        }
      }

      return { baseCommit, headCommit, isDirty };
    } catch (err) {
      logger.warn(`Failed to determine git context: ${err}`);
      return {
        baseCommit: null,
        headCommit: null,
        isDirty: false,
      };
    }
  }

  private async createNewReview(commitCtx: {
    baseCommit: CommitInfo | null;
    headCommit: CommitInfo | null;
    isDirty: boolean;
  }): Promise<void> {
    const author = getCurrentAuthor();

    try {
      const review = await this.store.createReview(
        commitCtx.baseCommit,
        commitCtx.headCommit,
        commitCtx.isDirty,
        author
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

    const controller = new ReviewCommentController(
      this.store,
      reviewId,
      this.workspaceRoot,
      getCurrentAuthor
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

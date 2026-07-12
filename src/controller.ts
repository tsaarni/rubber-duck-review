import * as path from 'node:path';
import * as vscode from 'vscode';
import { ReviewCommentImpl } from './comment';
import { buildSuggestionBlock } from './comments';
import { logger } from './logger';
import type { ReviewComment, ReviewStore } from './store';

/**
 * One ReviewCommentController per active review.
 */
export class ReviewCommentController implements vscode.Disposable {
  private readonly controller: vscode.CommentController;
  private readonly store: ReviewStore;
  private readonly reviewId: string;
  private readonly workspaceRoot: vscode.Uri;
  private readonly getAuthor: () => { name: string };

  // Maps store comment ID → ReviewCommentImpl
  private readonly comments = new Map<string, ReviewCommentImpl>();

  constructor(
    store: ReviewStore,
    reviewId: string,
    workspaceRoot: vscode.Uri,
    getAuthor: () => { name: string }
  ) {
    this.store = store;
    this.reviewId = reviewId;
    this.workspaceRoot = workspaceRoot;
    this.getAuthor = getAuthor;

    const safePath = workspaceRoot.fsPath
      .replace(/[^a-zA-Z0-9_-]/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '');

    this.controller = vscode.comments.createCommentController(
      `rubber-duck-review-${safePath}`,
      'Rubber Duck Review'
    );

    this.controller.options = {
      prompt: 'Rubber Duck Review',
      placeHolder: 'Add a review comment...',
    };

    this.controller.commentingRangeProvider = {
      provideCommentingRanges: (document) =>
        this.provideCommentingRanges(document),
    };
  }

  async initialize(): Promise<void> {
    const review = this.store.getReview(this.reviewId);
    if (!review) return;

    for (const storeComment of review.comments) {
      this.createThreadForComment(storeComment);
    }
  }

  // ── CommentingRangeProvider ──

  private provideCommentingRanges(document: vscode.TextDocument) {
    const folder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (!folder || folder.uri.toString() !== this.workspaceRoot.toString()) {
      return;
    }

    if (document.uri.scheme === 'file') {
      return {
        ranges: [new vscode.Range(0, 0, document.lineCount - 1, 0)],
        enableFileComments: true,
      };
    }

    if (document.uri.scheme === 'git') {
      if ((document.uri.query ?? '').includes('~')) return;
      return {
        ranges: [new vscode.Range(0, 0, document.lineCount - 1, 0)],
        enableFileComments: false,
      };
    }

    return;
  }

  // ── Comment CRUD ──

  async createComment(
    thread: vscode.CommentThread,
    input: string
  ): Promise<void> {
    const relativePath = this.getRelativePath(thread.uri);
    if (!relativePath) return;

    const range = thread.range;
    const subjectType: 'LINE' | 'FILE' = range ? 'LINE' : 'FILE';
    const startLine = range ? range.start.line + 1 : 1;
    const endLine = range ? range.end.line + 1 : 1;

    try {
      const author = this.getAuthor();
      const storeComment = await this.store.addComment(
        this.reviewId,
        relativePath,
        startLine,
        endLine,
        subjectType,
        input,
        author
      );

      const comment = new ReviewCommentImpl(
        storeComment,
        this.getAuthorInfo(storeComment),
        thread
      );
      thread.comments = [comment];
      thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
      thread.canReply = false;
      thread.label = this.buildThreadLabel(relativePath, range);

      this.comments.set(storeComment.id, comment);
    } catch (err) {
      logger.error(`Failed to create comment: ${err}`);
      vscode.window.showErrorMessage(
        `Failed to create comment: ${err instanceof Error ? err.message : err}`
      );
    }
  }

  /**
   * Create a new comment with a pre-filled suggestion block.
   * The comment is created in editing mode so the user can modify it.
   */
  async createSuggestion(
    uri: vscode.Uri,
    range: vscode.Range,
    selectedText: string
  ): Promise<void> {
    const relativePath = this.getRelativePath(uri);
    if (!relativePath) return;

    const subjectType: 'LINE' | 'FILE' = range ? 'LINE' : 'FILE';
    const startLine = range ? range.start.line + 1 : 1;
    const endLine = range ? range.end.line + 1 : 1;

    // Build suggestion block from selected text
    const suggestionBody = buildSuggestionBlock(selectedText);

    try {
      const author = this.getAuthor();
      const storeComment = await this.store.addComment(
        this.reviewId,
        relativePath,
        startLine,
        endLine,
        subjectType,
        suggestionBody,
        author
      );

      const thread = this.controller.createCommentThread(uri, range, []);
      const comment = new ReviewCommentImpl(
        storeComment,
        this.getAuthorInfo(storeComment),
        thread
      );

      // Put comment in editing mode so user can add context
      comment.startEdit();

      thread.comments = [comment];
      thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
      thread.canReply = false;
      thread.label = this.buildThreadLabel(relativePath, range);

      this.comments.set(storeComment.id, comment);
    } catch (err) {
      logger.error(`Failed to create suggestion: ${err}`);
      vscode.window.showErrorMessage(
        `Failed to create suggestion: ${err instanceof Error ? err.message : err}`
      );
    }
  }

  editComment(comment: ReviewCommentImpl): void {
    comment.startEdit();
  }

  async saveComment(comment: ReviewCommentImpl): Promise<void> {
    try {
      await this.store.editComment(
        this.reviewId,
        comment.commentId,
        comment.rawBody
      );
      comment.save();
    } catch (err) {
      logger.error(`Failed to save comment: ${err}`);
    }
  }

  cancelEditComment(comment: ReviewCommentImpl): void {
    comment.cancelEdit();
  }

  async deleteComment(comment: ReviewCommentImpl): Promise<void> {
    const confirm = await vscode.window.showWarningMessage(
      'Delete this comment?',
      { modal: true },
      'Delete'
    );
    if (confirm !== 'Delete') return;

    try {
      await this.store.deleteComment(this.reviewId, comment.commentId);
    } catch (err) {
      logger.error(`Failed to delete comment: ${err}`);
      return;
    }

    const thread = comment.parent;
    thread.comments = thread.comments.filter((c) => c !== comment);
    this.comments.delete(comment.commentId);

    if (thread.comments.length === 0) {
      thread.dispose();
    }
  }

  // ── Helpers ──

  /** Get author info, preferring stored comment author, falling back to current git user. */
  private getAuthorInfo(
    storeComment: ReviewComment
  ): vscode.CommentAuthorInformation {
    // Use stored author if available
    if (storeComment.author?.name) {
      return { name: storeComment.author.name };
    }
    // Fall back to current git user
    const current = this.getAuthor();
    if (current?.name) {
      return { name: current.name };
    }
    return { name: 'Unknown' };
  }

  private createThreadForComment(storeComment: ReviewComment): void {
    const fileUri = vscode.Uri.joinPath(this.workspaceRoot, storeComment.path);

    let range: vscode.Range;
    if (
      storeComment.subjectType === 'LINE' &&
      storeComment.startLine != null &&
      storeComment.endLine != null
    ) {
      range = new vscode.Range(
        storeComment.startLine - 1,
        0,
        storeComment.endLine - 1,
        0
      );
    } else {
      range = new vscode.Range(0, 0, 0, 0);
    }

    const thread = this.controller.createCommentThread(fileUri, range, []);
    const comment = new ReviewCommentImpl(
      storeComment,
      this.getAuthorInfo(storeComment),
      thread
    );

    thread.comments = [comment];
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    thread.canReply = false;
    thread.label = this.buildThreadLabel(storeComment.path, range);

    this.comments.set(storeComment.id, comment);
  }

  private getRelativePath(uri: vscode.Uri): string | undefined {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder || folder.uri.toString() !== this.workspaceRoot.toString()) {
      return undefined;
    }
    const rel = path.relative(this.workspaceRoot.fsPath, uri.fsPath);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
    return rel.replace(/\\/g, '/');
  }

  private buildThreadLabel(
    filePath: string,
    range: vscode.Range | undefined
  ): string {
    const fileName = path.basename(filePath);
    if (!range) return fileName;
    return `${fileName}:${range.start.line + 1}-${range.end.line + 1}`;
  }

  /** Find our ReviewCommentImpl from a VS Code Comment object. */
  findComment(vscodeComment: vscode.Comment): ReviewCommentImpl | undefined {
    if (vscodeComment instanceof ReviewCommentImpl) {
      return vscodeComment;
    }
    return undefined;
  }

  dispose(): void {
    for (const comment of this.comments.values()) {
      comment.parent.dispose();
    }
    this.comments.clear();
    this.controller.dispose();
  }
}

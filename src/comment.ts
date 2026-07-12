import * as vscode from 'vscode';
import type { ReviewComment as StoreComment } from './store';

/**
 * VS Code Comment implementation following the official comment-sample pattern.
 */
export class ReviewCommentImpl implements vscode.Comment {
  public readonly commentId: string;
  public readonly author: vscode.CommentAuthorInformation;
  public label: string | undefined;
  public mode: vscode.CommentMode;
  public contextValue: string;
  public parent: vscode.CommentThread;
  public timestamp: Date | undefined;

  // The body property - VS Code reads/writes this directly
  public body: string | vscode.MarkdownString;

  // Saved body for cancel functionality
  private savedBody: string | vscode.MarkdownString;

  constructor(
    storeComment: StoreComment,
    author: vscode.CommentAuthorInformation,
    thread: vscode.CommentThread
  ) {
    this.commentId = storeComment.id;
    this.author = author;
    this.parent = thread;
    this.mode = vscode.CommentMode.Preview;
    this.contextValue = 'canEdit,canDelete';

    const md = new vscode.MarkdownString(storeComment.body);
    md.isTrusted = true;
    md.supportThemeIcons = true;
    this.body = md;
    this.savedBody = this.body;

    // Use VS Code's built-in timestamp support
    this.timestamp = new Date(storeComment.createdAt);
  }

  /** Switch to editing mode. */
  startEdit(): void {
    this.mode = vscode.CommentMode.Editing;
    this.contextValue = 'isEditing,canDelete';
    this.refresh();
  }

  /** Save current body and return to preview mode. */
  save(): void {
    this.savedBody = this.body;
    this.mode = vscode.CommentMode.Preview;
    this.contextValue = 'canEdit,canDelete';
    this.refresh();
  }

  /** Restore saved body and return to preview mode. */
  cancelEdit(): void {
    this.body = this.savedBody;
    this.mode = vscode.CommentMode.Preview;
    this.contextValue = 'canEdit,canDelete';
    this.refresh();
  }

  /** Get the raw text content (for saving to store). */
  get rawBody(): string {
    if (typeof this.body === 'string') {
      return this.body;
    }
    return this.body.value ?? '';
  }

  /** Trigger VS Code UI update. */
  private refresh(): void {
    this.parent.comments = [...this.parent.comments];
  }
}

// Note: VS Code handles timestamp formatting automatically via the `timestamp` property.
// The `comments.useRelativeTime` setting controls whether relative time is shown.

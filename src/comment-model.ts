// VS Code Comment implementation wrapping a stored review comment.

import * as vscode from 'vscode';
import type { ReviewComment as StoreComment } from './store';

export class ReviewCommentImpl implements vscode.Comment {
  public readonly commentId: string;
  public readonly subjectType: 'LINE' | 'FILE';
  public readonly author: vscode.CommentAuthorInformation;
  public label: string | undefined;
  public mode: vscode.CommentMode;
  public contextValue: string;
  public parent: vscode.CommentThread;
  public timestamp: Date | undefined;

  public body: string | vscode.MarkdownString;

  // Saved body for cancel functionality, stores the original text before edits.
  private savedBody: string | vscode.MarkdownString;

  constructor(
    storeComment: StoreComment,
    author: vscode.CommentAuthorInformation,
    thread: vscode.CommentThread
  ) {
    this.commentId = storeComment.id;
    this.subjectType = storeComment.subjectType;
    this.author = author;
    this.parent = thread;
    this.mode = vscode.CommentMode.Preview;
    this.contextValue = 'canEdit,canDelete';

    const md = new vscode.MarkdownString(storeComment.body);
    md.isTrusted = true;
    md.supportThemeIcons = true;
    this.body = md;
    this.savedBody = this.body;

    this.timestamp = new Date(storeComment.createdAt);
  }

  startEdit(): void {
    this.mode = vscode.CommentMode.Editing;
    this.contextValue = 'isEditing,canDelete';
    this.refresh();
  }

  save(): void {
    this.savedBody = this.body;
    this.mode = vscode.CommentMode.Preview;
    this.contextValue = 'canEdit,canDelete';
    this.refresh();
  }

  cancelEdit(): void {
    this.body = this.savedBody;
    this.mode = vscode.CommentMode.Preview;
    this.contextValue = 'canEdit,canDelete';
    this.refresh();
  }

  // Get the raw text content for saving to store.
  get rawBody(): string {
    if (typeof this.body === 'string') {
      return this.body;
    }
    return this.body.value ?? '';
  }

  private refresh(): void {
    this.parent.comments = [...this.parent.comments];
  }
}

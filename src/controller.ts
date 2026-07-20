// Manages VS Code comment threads for a single active review.

import * as path from 'node:path';
import * as vscode from 'vscode';
import { ReviewCommentImpl } from './comment-model';
import { logger } from './logger';
import type {
  AuthorInfo,
  ReviewComment,
  ReviewStore,
  ReviewSymbolInfo,
} from './store';

interface SymbolWithContainer {
  symbol: vscode.DocumentSymbol;
  containerName?: string;
}

function symbolKindToString(kind: vscode.SymbolKind): string {
  switch (kind) {
    case vscode.SymbolKind.File:
      return 'file';
    case vscode.SymbolKind.Module:
      return 'module';
    case vscode.SymbolKind.Namespace:
      return 'namespace';
    case vscode.SymbolKind.Package:
      return 'package';
    case vscode.SymbolKind.Class:
      return 'class';
    case vscode.SymbolKind.Method:
      return 'method';
    case vscode.SymbolKind.Property:
      return 'property';
    case vscode.SymbolKind.Field:
      return 'field';
    case vscode.SymbolKind.Constructor:
      return 'constructor';
    case vscode.SymbolKind.Enum:
      return 'enum';
    case vscode.SymbolKind.Interface:
      return 'interface';
    case vscode.SymbolKind.Function:
      return 'function';
    case vscode.SymbolKind.Variable:
      return 'variable';
    case vscode.SymbolKind.Constant:
      return 'constant';
    case vscode.SymbolKind.String:
      return 'string';
    case vscode.SymbolKind.Number:
      return 'number';
    case vscode.SymbolKind.Boolean:
      return 'boolean';
    case vscode.SymbolKind.Array:
      return 'array';
    case vscode.SymbolKind.Object:
      return 'object';
    case vscode.SymbolKind.Key:
      return 'key';
    case vscode.SymbolKind.Null:
      return 'null';
    case vscode.SymbolKind.EnumMember:
      return 'enumMember';
    case vscode.SymbolKind.Struct:
      return 'struct';
    case vscode.SymbolKind.Event:
      return 'event';
    case vscode.SymbolKind.Operator:
      return 'operator';
    case vscode.SymbolKind.TypeParameter:
      return 'typeParameter';
    default:
      return 'symbol';
  }
}

function findDeepestSymbol(
  symbols: vscode.DocumentSymbol[],
  range: vscode.Range,
  parentContainer?: string
): SymbolWithContainer | undefined {
  for (const sym of symbols) {
    if (sym.range.contains(range)) {
      const childContainer = parentContainer
        ? `${parentContainer}.${sym.name}`
        : sym.name;
      const childMatch = findDeepestSymbol(sym.children, range, childContainer);
      if (childMatch) {
        return childMatch;
      }
      return {
        symbol: sym,
        containerName: parentContainer,
      };
    }
  }
  return undefined;
}

export class ReviewCommentController implements vscode.Disposable {
  private readonly controller: vscode.CommentController;
  private readonly store: ReviewStore;
  private readonly reviewId: string;
  private readonly workspaceRoot: vscode.Uri;
  private readonly author: AuthorInfo;

  // Maps store comment ID -> ReviewCommentImpl
  private readonly comments = new Map<string, ReviewCommentImpl>();

  constructor(
    store: ReviewStore,
    reviewId: string,
    workspaceRoot: vscode.Uri,
    author: AuthorInfo
  ) {
    this.store = store;
    this.reviewId = reviewId;
    this.workspaceRoot = workspaceRoot;
    this.author = author;

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

  // CommentingRangeProvider

  private provideCommentingRanges(document: vscode.TextDocument) {
    const folder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (folder?.uri.toString() !== this.workspaceRoot.toString()) {
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

  // Suggestion block

  private buildSuggestionBlock(selectedText: string): string {
    return `\`\`\`suggestion\n${selectedText.trimEnd()}\n\`\`\``;
  }

  // Capture the lines for a LINE comment range.
  private captureSnippet(
    doc: vscode.TextDocument,
    startLine: number,
    endLine: number
  ): string {
    const snippetLines: string[] = [];
    for (let i = startLine; i <= endLine; i++) {
      snippetLines.push(doc.lineAt(i - 1).text);
    }
    return snippetLines.join('\n');
  }

  // Retrieve enclosing symbol (function, method, class) from VS Code language provider.
  private async getEnclosingSymbol(
    uri: vscode.Uri,
    range?: vscode.Range
  ): Promise<ReviewSymbolInfo | undefined> {
    if (!range) return undefined;
    try {
      let targetUri = uri;
      if (targetUri.scheme === 'git') {
        const relPath = this.getRelativePath(targetUri);
        if (relPath) {
          targetUri = vscode.Uri.joinPath(this.workspaceRoot, relPath);
        }
      }

      const symbols = await vscode.commands.executeCommand<
        vscode.DocumentSymbol[]
      >('vscode.executeDocumentSymbolProvider', targetUri);

      if (!symbols || symbols.length === 0) return undefined;

      const match = findDeepestSymbol(symbols, range);
      if (!match) return undefined;

      return {
        name: match.symbol.name,
        kind: symbolKindToString(match.symbol.kind),
        containerName: match.containerName,
        detail: match.symbol.detail || undefined,
        startLine: match.symbol.range.start.line + 1,
        endLine: match.symbol.range.end.line + 1,
      };
    } catch (err) {
      logger.debug(`Failed to fetch document symbols: ${err}`);
      return undefined;
    }
  }

  // Comment CRUD

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
    const startColumn = range ? range.start.character + 1 : undefined;
    const endColumn = range ? range.end.character + 1 : undefined;

    try {
      const doc = await vscode.workspace.openTextDocument(thread.uri);
      const languageId = doc.languageId;
      const symbol = await this.getEnclosingSymbol(thread.uri, range);

      let snippet: string | undefined;
      if (subjectType === 'LINE' && range) {
        snippet = this.captureSnippet(doc, startLine, endLine);
      }

      const storeComment = await this.store.addComment(
        this.reviewId,
        relativePath,
        startLine,
        endLine,
        subjectType,
        input,
        snippet,
        {
          startColumn,
          endColumn,
          languageId,
          symbol,
        }
      );

      const comment = new ReviewCommentImpl(
        storeComment,
        this.getAuthorInfo(),
        thread
      );
      thread.comments = [comment];
      thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
      thread.canReply = false;

      this.comments.set(storeComment.id, comment);
    } catch (err) {
      logger.error(`Failed to create comment: ${err}`);
      vscode.window.showErrorMessage(
        `Failed to create comment: ${err instanceof Error ? err.message : err}`
      );
    }
  }

  // Create a comment pre-filled with a suggestion block, opened in editing mode.
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
    const startColumn = range ? range.start.character + 1 : undefined;
    const endColumn = range ? range.end.character + 1 : undefined;

    const suggestionBody = this.buildSuggestionBlock(selectedText);

    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      const languageId = doc.languageId;
      const symbol = await this.getEnclosingSymbol(uri, range);

      let snippet: string | undefined;
      if (subjectType === 'LINE') {
        snippet = this.captureSnippet(doc, startLine, endLine);
      }

      const storeComment = await this.store.addComment(
        this.reviewId,
        relativePath,
        startLine,
        endLine,
        subjectType,
        suggestionBody,
        snippet,
        {
          startColumn,
          endColumn,
          languageId,
          symbol,
        }
      );

      const thread = this.controller.createCommentThread(uri, range, []);
      const comment = new ReviewCommentImpl(
        storeComment,
        this.getAuthorInfo(),
        thread
      );

      // Put comment in editing mode so user can add context
      comment.startEdit();

      thread.comments = [comment];
      thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
      thread.canReply = false;

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

  async createFileComment(uri: vscode.Uri): Promise<void> {
    const relativePath = this.getRelativePath(uri);
    if (!relativePath) return;

    // Expand existing file comment thread if present
    for (const comment of this.comments.values()) {
      if (
        comment.subjectType === 'FILE' &&
        comment.parent.uri.fsPath === uri.fsPath
      ) {
        comment.parent.collapsibleState =
          vscode.CommentThreadCollapsibleState.Expanded;
        return;
      }
    }

    const thread = this.controller.createCommentThread(
      uri,
      undefined as unknown as vscode.Range,
      []
    );
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
  }

  // Helpers

  private getAuthorInfo(): vscode.CommentAuthorInformation {
    return { name: this.author.name };
  }

  private createThreadForComment(storeComment: ReviewComment): void {
    const fileUri = vscode.Uri.joinPath(this.workspaceRoot, storeComment.path);

    let range: vscode.Range | undefined;
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
    }

    const thread = this.controller.createCommentThread(
      fileUri,
      range as unknown as vscode.Range,
      []
    );
    const comment = new ReviewCommentImpl(
      storeComment,
      this.getAuthorInfo(),
      thread
    );

    thread.comments = [comment];
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    thread.canReply = false;

    this.comments.set(storeComment.id, comment);
  }

  private getRelativePath(uri: vscode.Uri): string | undefined {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (folder?.uri.toString() !== this.workspaceRoot.toString()) {
      return undefined;
    }
    const rel = path.relative(this.workspaceRoot.fsPath, uri.fsPath);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
    return rel.replace(/\\/g, '/');
  }

  dispose(): void {
    for (const comment of this.comments.values()) {
      comment.parent.dispose();
    }
    this.comments.clear();
    this.controller.dispose();
  }
}

// Extension entry point: activation, commands, status bar, and workspace-folder lifecycle.

import * as vscode from 'vscode';
import type { ReviewCommentImpl } from './comment-model';
import { getGitContext } from './git';
import { logger } from './logger';
import { ReviewManager } from './manager';
import { ReviewStore } from './store';

// Module-level state

const managers = new Map<string, ReviewManager>();
let statusBarItem: vscode.StatusBarItem | undefined;
let suggestionHintDecoration: vscode.TextEditorDecorationType | undefined;

// Activation / Deactivation

export function activate(context: vscode.ExtensionContext): void {
  const channel = vscode.window.createOutputChannel('Rubber Duck Review', {
    log: true,
  });
  logger.init(channel);

  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100
  );
  context.subscriptions.push(statusBarItem);

  // Initialize managers for all existing workspace folders
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    createManager(folder);
  }
  updateStatusBar();

  // Suggestion hint decoration

  suggestionHintDecoration = vscode.window.createTextEditorDecorationType({
    after: {
      contentText:
        '  💡 Select code, then run "Rubber Duck: Add Suggestion" from Command Palette',
      color: '#888888',
      fontStyle: 'italic',
    },
    isWholeLine: false,
  });
  context.subscriptions.push(suggestionHintDecoration);

  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection((e) => {
      updateSuggestionHint(e.textEditor);
    })
  );
  if (vscode.window.activeTextEditor) {
    updateSuggestionHint(vscode.window.activeTextEditor);
  }

  // Register commands

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'rubberDuck.startReview',
      handleStartReview
    ),
    vscode.commands.registerCommand('rubberDuck.newReview', handleNewReview),
    vscode.commands.registerCommand(
      'rubberDuck.switchReview',
      handleSwitchReview
    ),
    vscode.commands.registerCommand('rubberDuck.stopReview', handleStopReview),
    vscode.commands.registerCommand(
      'rubberDuck.clearReview',
      handleClearReview
    ),
    vscode.commands.registerCommand(
      'rubberDuck.deleteAllReviews',
      handleDeleteAllReviews
    ),
    vscode.commands.registerCommand(
      'rubberDuck.exportMarkdown',
      handleExportMarkdown
    ),
    vscode.commands.registerCommand(
      'rubberDuck.createComment',
      handleCreateComment
    ),
    vscode.commands.registerCommand(
      'rubberDuck.editComment',
      handleEditComment
    ),
    vscode.commands.registerCommand(
      'rubberDuck.deleteComment',
      handleDeleteComment
    ),
    vscode.commands.registerCommand(
      'rubberDuck.saveComment',
      handleSaveComment
    ),
    vscode.commands.registerCommand(
      'rubberDuck.cancelEditComment',
      handleCancelEditComment
    ),
    vscode.commands.registerCommand(
      'rubberDuck.createSuggestion',
      handleCreateSuggestion
    ),
    vscode.commands.registerCommand(
      'rubberDuck.createFileComment',
      handleCreateFileComment
    )
  );

  // Workspace folder changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders((event) => {
      for (const folder of event.added) {
        createManager(folder);
      }
      for (const folder of event.removed) {
        const mgr = managers.get(folder.uri.fsPath);
        if (mgr) {
          mgr.dispose();
          managers.delete(folder.uri.fsPath);
        }
      }
      updateStatusBar();
    })
  );

  logger.info('Rubber Duck Review activated');
}

export function deactivate(): void {
  for (const [_path, mgr] of managers) {
    try {
      mgr.dispose();
    } catch (err) {
      logger.error(`Error disposing manager: ${err}`);
    }
  }
  managers.clear();
  statusBarItem?.dispose();
  statusBarItem = undefined;
}

// Manager factory

async function createManager(folder: vscode.WorkspaceFolder): Promise<void> {
  try {
    const cfg = vscode.workspace.getConfiguration(undefined, folder.uri);
    const customPath = cfg.get<string>('rubberDuck.reviewsFilePath');

    const store = await ReviewStore.load(folder.uri, customPath);
    const gitContext = await getGitContext(folder.uri);

    const mgr = new ReviewManager(
      store,
      folder.uri,
      gitContext,
      updateStatusBar
    );
    managers.set(folder.uri.fsPath, mgr);
  } catch (err) {
    logger.error(`Failed to create manager for ${folder.uri.fsPath}: ${err}`);
    vscode.window.showErrorMessage(
      `Rubber Duck Review: Failed to initialize for ${folder.name}: ${err instanceof Error ? err.message : err}`
    );
  }
}

// Status bar

function updateStatusBar(): void {
  if (!statusBarItem) return;

  const activeMgrs = Array.from(managers.values()).filter(
    (m) => m.isReviewActive
  );

  if (activeMgrs.length === 0) {
    statusBarItem.text = '$(comment-discussion) Start Review';
    statusBarItem.command = 'rubberDuck.startReview';
    statusBarItem.tooltip = 'No active reviews. Click to start one.';
  } else if (activeMgrs.length === 1) {
    const m = activeMgrs[0];
    statusBarItem.text = `$(comment-discussion) Reviewing ${m.folderName}`;
    statusBarItem.command = 'rubberDuck.stopReview';
    statusBarItem.tooltip = new vscode.MarkdownString(
      `${m.folderName}: ${m.commentCount} comment(s) — Click to stop review`
    );
  } else {
    statusBarItem.text = `$(comment-discussion) ${activeMgrs.length} reviews`;
    statusBarItem.command = 'rubberDuck.stopReview';
    const tooltipLines = activeMgrs.map(
      (m) => `- ${m.folderName}: ${m.commentCount} comment(s)`
    );
    statusBarItem.tooltip = new vscode.MarkdownString(tooltipLines.join('\n'));
  }

  statusBarItem.show();
}

function updateSuggestionHint(editor: vscode.TextEditor): void {
  if (!suggestionHintDecoration) return;

  const hasActiveReview = Array.from(managers.values()).some(
    (m) => m.isReviewActive
  );

  if (!hasActiveReview || editor.selection.isEmpty) {
    editor.setDecorations(suggestionHintDecoration, []);
    return;
  }

  const line = editor.selection.active.line;
  const range = new vscode.Range(
    line,
    Number.MAX_SAFE_INTEGER,
    line,
    Number.MAX_SAFE_INTEGER
  );
  editor.setDecorations(suggestionHintDecoration, [{ range }]);
}

// Helpers

async function resolveManagerForCommand(): Promise<ReviewManager | undefined> {
  const mgrList = Array.from(managers.values());

  if (mgrList.length === 0) {
    vscode.window.showErrorMessage('No workspace folders open.');
    return undefined;
  }

  if (mgrList.length === 1) {
    return mgrList[0];
  }

  // Multi-root: try active editor
  const editor = vscode.window.activeTextEditor;
  if (editor) {
    const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
    if (folder) {
      const mgr = managers.get(folder.uri.fsPath);
      if (mgr) return mgr;
    }
  }

  // Multi-root: show picker
  const items = mgrList.map((m) => ({
    label: m.folderName,
    description: m.isReviewActive
      ? `active (${m.commentCount} comments)`
      : 'no active review',
    manager: m,
  }));

  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: 'Select a workspace folder',
  });
  return pick?.manager;
}

// Find the manager that owns a given CommentThread.
function getManagerByThread(
  thread: vscode.CommentThread
): ReviewManager | undefined {
  const folder = vscode.workspace.getWorkspaceFolder(thread.uri);
  if (!folder) return undefined;
  return managers.get(folder.uri.fsPath);
}

// Command handlers: user-facing

async function handleStartReview(): Promise<void> {
  const mgr = await resolveManagerForCommand();
  if (!mgr) return;
  await mgr.startReview();
}

function handleStopReview(): void {
  const activeMgrs = Array.from(managers.values()).filter(
    (m) => m.isReviewActive
  );
  for (const mgr of activeMgrs) {
    mgr.stopReview();
  }
}

async function handleNewReview(): Promise<void> {
  const mgr = await resolveManagerForCommand();
  if (!mgr) return;
  await mgr.newReview();
}

async function handleSwitchReview(): Promise<void> {
  const mgr = await resolveManagerForCommand();
  if (!mgr) return;
  await mgr.switchReview();
}

async function handleClearReview(): Promise<void> {
  const mgr = await resolveManagerForCommand();
  if (!mgr) return;
  await mgr.clearReview();
}

async function handleDeleteAllReviews(): Promise<void> {
  const mgr = await resolveManagerForCommand();
  if (!mgr) return;
  await mgr.deleteAllReviews();
}

async function handleExportMarkdown(): Promise<void> {
  const activeMgrs = Array.from(managers.values()).filter(
    (m) => m.isReviewActive
  );

  if (activeMgrs.length === 0) {
    vscode.window.showInformationMessage('No active reviews to export.');
    return;
  }

  if (activeMgrs.length === 1) {
    await activeMgrs[0].exportMarkdown();
    return;
  }

  const items = activeMgrs.map((m) => ({
    label: m.folderName,
    description: `${m.commentCount} comment(s)`,
    manager: m,
  }));

  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: 'Select a review to export',
  });
  if (pick) {
    await pick.manager.exportMarkdown();
  }
}

// Command handlers: comment actions

async function handleCreateComment(
  first: vscode.CommentThread | vscode.CommentReply,
  second?: string
): Promise<void> {
  let thread: vscode.CommentThread;
  let input: string;

  if (first && 'text' in first && 'thread' in first) {
    thread = first.thread;
    input = first.text;
  } else {
    thread = first as vscode.CommentThread;
    input = second ?? '';
  }

  const mgr = getManagerByThread(thread);
  if (!mgr) return;
  await mgr.createComment(thread, input);
}

function handleEditComment(comment: ReviewCommentImpl): void {
  const mgr = getManagerByThread(comment.parent);
  if (!mgr) return;
  mgr.editComment(comment);
}

async function handleDeleteComment(comment: ReviewCommentImpl): Promise<void> {
  const mgr = getManagerByThread(comment.parent);
  if (!mgr) return;
  await mgr.deleteComment(comment);
}

async function handleSaveComment(comment: ReviewCommentImpl): Promise<void> {
  const mgr = getManagerByThread(comment.parent);
  if (!mgr) return;
  await mgr.saveComment(comment);
}

function handleCancelEditComment(comment: ReviewCommentImpl): void {
  const mgr = getManagerByThread(comment.parent);
  if (!mgr) return;
  mgr.cancelEditComment(comment);
}

async function handleCreateSuggestion(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showErrorMessage('No active editor.');
    return;
  }

  if (editor.selection.isEmpty) {
    vscode.window.showErrorMessage('Select code to create a suggestion.');
    return;
  }

  const mgr = await resolveManagerForCommand();
  if (!mgr) return;

  if (!mgr.isReviewActive) {
    vscode.window.showErrorMessage('Start a review first.');
    return;
  }

  const selectedText = editor.document.getText(editor.selection);
  const range = new vscode.Range(editor.selection.start, editor.selection.end);

  await mgr.createSuggestion(editor.document.uri, range, selectedText);
}

async function handleCreateFileComment(uri?: vscode.Uri): Promise<void> {
  const mgr = await resolveManagerForCommand();
  if (!mgr) return;
  await mgr.createFileComment(uri);
}

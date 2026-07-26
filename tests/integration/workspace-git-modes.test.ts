import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { getGitContext } from '../../src/git';
import { getFixturesRootDir } from '../fixtures/setup-fixtures';

suite('Git Context & Workspace Modes Integration Tests', () => {
  test('Non-git workspace startReview initializes review without git metadata', async () => {
    const nonGitDir = path.join(getFixturesRootDir(), '1-non-git-workspace');
    const context = await getGitContext(vscode.Uri.file(nonGitDir));
    assert.strictEqual(
      context,
      undefined,
      'Non-git workspace context should be undefined'
    );
  });

  test('Git main-only workspace startReview resolves branch main via VS Code', async () => {
    const gitMainDir = path.join(getFixturesRootDir(), '2-git-main-only');
    const context = await getGitContext(vscode.Uri.file(gitMainDir));
    assert.ok(context);

    const branch = await context.getCurrentBranch();
    const defaultBranch = await context.getDefaultBranch();

    assert.strictEqual(branch, 'main');
    assert.strictEqual(defaultBranch, undefined);
  });

  test('Git feature branch workspace startReview resolves feature branch, remote base, and merge commit', async () => {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    assert.ok(workspaceFolders && workspaceFolders.length > 0);
    const rootPath = workspaceFolders[0].uri.fsPath;
    const reviewsPath = path.join(rootPath, '.vscode', 'reviews.json');

    await vscode.commands.executeCommand('rubberDuck.startReview');

    assert.ok(
      fs.existsSync(reviewsPath),
      'reviews.json should be created by startReview'
    );
    const content = JSON.parse(fs.readFileSync(reviewsPath, 'utf8'));
    const activeReview = content.reviews[0];

    assert.ok(activeReview, 'Active review should exist');
    assert.strictEqual(
      activeReview.branch,
      'feature/auth',
      'Branch should be feature/auth'
    );
    assert.strictEqual(
      activeReview.baseBranch,
      'origin/main',
      'Base branch should be origin/main'
    );
    assert.ok(
      activeReview.baseCommit?.id,
      'Base commit SHA should be resolved'
    );
  });
});

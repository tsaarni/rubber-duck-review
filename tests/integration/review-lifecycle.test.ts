import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as sinon from 'sinon';
import * as vscode from 'vscode';

suite('Review Lifecycle Integration Suite', () => {
  let sandbox: sinon.SinonSandbox;

  setup(async () => {
    sandbox = sinon.createSandbox();
    await new Promise((resolve) => setTimeout(resolve, 500));
  });

  teardown(() => {
    sandbox.restore();
  });

  test('Start Review initializes review state and reviews.json', async () => {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    assert.ok(workspaceFolders && workspaceFolders.length > 0);
    const rootPath = workspaceFolders[0].uri.fsPath;
    const reviewsPath = path.join(rootPath, '.vscode', 'reviews.json');

    await vscode.commands.executeCommand('rubberDuck.startReview');

    assert.ok(fs.existsSync(reviewsPath), '.vscode/reviews.json should exist');
    const content = JSON.parse(fs.readFileSync(reviewsPath, 'utf8'));
    assert.strictEqual(content.version, 1);
    assert.ok(content.reviews.length >= 1);
  });

  test('Sequence: Create review -> Stop review -> Switch/Open existing review', async () => {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    assert.ok(workspaceFolders);
    const rootPath = workspaceFolders[0].uri.fsPath;
    const reviewsPath = path.join(rootPath, '.vscode', 'reviews.json');

    // 1. Create a review
    await vscode.commands.executeCommand('rubberDuck.startReview');
    assert.ok(fs.existsSync(reviewsPath));

    const contentBefore = JSON.parse(fs.readFileSync(reviewsPath, 'utf8'));
    const reviewId = contentBefore.reviews[0].id;
    assert.ok(reviewId);

    // 2. Stop review
    await vscode.commands.executeCommand('rubberDuck.stopReview');
    assert.ok(fs.existsSync(reviewsPath));

    // 3. Switch back to existing review
    const shortId = reviewId.slice(0, 8);
    sandbox
      .stub(vscode.window, 'showQuickPick')
      .callsFake(async (items: unknown) => {
        const list = (
          Array.isArray(items) ? items : await items
        ) as vscode.QuickPickItem[];
        const match = list.find((i) => i.label?.includes(shortId));
        return match ?? list[0];
      });

    await vscode.commands.executeCommand('rubberDuck.switchReview');

    const contentAfter = JSON.parse(fs.readFileSync(reviewsPath, 'utf8'));
    assert.ok(
      contentAfter.reviews.some((r: { id: string }) => r.id === reviewId)
    );
  });

  test('New Review command creates a new review entry in store', async () => {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    assert.ok(workspaceFolders);
    const rootPath = workspaceFolders[0].uri.fsPath;
    const reviewsPath = path.join(rootPath, '.vscode', 'reviews.json');

    await vscode.commands.executeCommand('rubberDuck.startReview');
    const content1 = JSON.parse(fs.readFileSync(reviewsPath, 'utf8'));
    const initialCount = content1.reviews.length;

    await vscode.commands.executeCommand('rubberDuck.newReview');
    const content2 = JSON.parse(fs.readFileSync(reviewsPath, 'utf8'));
    assert.strictEqual(content2.reviews.length, initialCount + 1);
  });

  test('Export Markdown command exports review with comments, snippets, and symbols', async () => {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    assert.ok(workspaceFolders);
    const rootPath = workspaceFolders[0].uri.fsPath;
    const exportPath = path.join(rootPath, 'export-test-output.md');
    const mainTsFile = path.join(rootPath, 'main.ts');

    if (fs.existsSync(exportPath)) {
      fs.unlinkSync(exportPath);
    }

    await vscode.commands.executeCommand('rubberDuck.startReview');

    // Create a suggestion comment inside function auth()
    const document = await vscode.workspace.openTextDocument(mainTsFile);
    const editor = await vscode.window.showTextDocument(document);
    editor.selection = new vscode.Selection(
      new vscode.Position(2, 5),
      new vscode.Position(2, 10)
    );
    await vscode.commands.executeCommand('rubberDuck.createSuggestion');

    sandbox
      .stub(vscode.window, 'showSaveDialog')
      .resolves(vscode.Uri.file(exportPath));

    await vscode.commands.executeCommand('rubberDuck.exportMarkdown');

    assert.ok(fs.existsSync(exportPath), 'Exported markdown file should exist');
    const exportedText = fs.readFileSync(exportPath, 'utf8');

    // Assert key markdown structures: header, file path, symbol info, and escaped suggestion block in blockquote
    assert.ok(
      exportedText.includes('# Code Review'),
      'Markdown header should be present'
    );
    assert.ok(
      exportedText.includes('main.ts'),
      'File path main.ts should be in export'
    );
    assert.ok(
      exportedText.includes('auth'),
      'Function symbol name should be in export'
    );
    assert.ok(
      exportedText.includes('\\`\\`\\`suggestion'),
      'Escaped suggestion block inside blockquote should be in export'
    );

    if (fs.existsSync(exportPath)) {
      fs.unlinkSync(exportPath);
    }
  });

  test('Delete All Reviews with confirmation removes reviews file from disk', async () => {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    assert.ok(workspaceFolders);
    const rootPath = workspaceFolders[0].uri.fsPath;
    const reviewsPath = path.join(rootPath, '.vscode', 'reviews.json');

    await vscode.commands.executeCommand('rubberDuck.startReview');

    sandbox
      .stub(vscode.window, 'showWarningMessage')
      .resolves('Delete All' as unknown as vscode.MessageItem);

    await vscode.commands.executeCommand('rubberDuck.deleteAllReviews');
    assert.strictEqual(fs.existsSync(reviewsPath), false);
  });
});

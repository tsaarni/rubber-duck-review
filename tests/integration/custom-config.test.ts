import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as sinon from 'sinon';
import * as vscode from 'vscode';

suite('Custom Configuration Integration Tests', () => {
  let sandbox: sinon.SinonSandbox;

  setup(() => {
    sandbox = sinon.createSandbox();
  });

  teardown(() => {
    sandbox.restore();
  });

  test('Custom reviewsFilePath setting updates destination reviews JSON file path', async () => {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    assert.ok(workspaceFolders && workspaceFolders.length > 0);
    const folder = workspaceFolders[0];
    const customRelativePath = '.config/custom-reviews.json';
    const customFullPath = path.join(folder.uri.fsPath, customRelativePath);

    if (fs.existsSync(customFullPath)) {
      fs.unlinkSync(customFullPath);
    }

    const config = vscode.workspace.getConfiguration(undefined, folder.uri);
    await config.update(
      'rubberDuck.reviewsFilePath',
      customRelativePath,
      vscode.ConfigurationTarget.WorkspaceFolder
    );

    try {
      const { ReviewStore } = await import('../../src/store.js');
      const store = await ReviewStore.load(folder.uri, customRelativePath);
      await store.createReview(null, null, null, null, false);
      assert.ok(
        fs.existsSync(customFullPath),
        'Reviews should be created at custom path .config/custom-reviews.json'
      );
    } finally {
      // Revert configuration setting
      await config.update(
        'rubberDuck.reviewsFilePath',
        undefined,
        vscode.ConfigurationTarget.WorkspaceFolder
      );
      if (fs.existsSync(customFullPath)) {
        fs.unlinkSync(customFullPath);
      }
    }
  });
});

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { defineConfig } from '@vscode/test-cli';

const tmpDir = fs.realpathSync(os.tmpdir());
const workspacePath = path.join(tmpDir, 'rubber-duck-test-workspaces', '3-git-feature-branch');

export default defineConfig({
  files: 'dist/tests/integration/**/*.test.js',
  version: 'stable',
  launchArgs: [workspacePath],
  mocha: {
    ui: 'tdd',
    timeout: 30000,
  },
});


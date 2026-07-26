import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ISOLATED_GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  PATH: process.env.PATH ?? '',
  SYSTEMROOT: process.env.SYSTEMROOT ?? '',
  GIT_AUTHOR_NAME: 'Test User',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test User',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

const TEMPLATES_DIR = path.resolve(__dirname, 'templates');

export function getFixturesRootDir(): string {
  const tmpDir = fs.realpathSync(os.tmpdir());
  return path.join(tmpDir, 'rubber-duck-test-workspaces');
}

export function setupFixtures(baseDir: string = getFixturesRootDir()): string {
  // Clean workspace root directory if exists
  if (fs.existsSync(baseDir)) {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
  fs.mkdirSync(baseDir, { recursive: true });

  // 1. Non-git workspace
  const nonGitDir = path.join(baseDir, '1-non-git-workspace');
  fs.cpSync(path.join(TEMPLATES_DIR, '1-non-git-workspace'), nonGitDir, {
    recursive: true,
  });

  // 2. Git workspace (main branch only)
  const gitMainDir = path.join(baseDir, '2-git-main-only');
  fs.cpSync(path.join(TEMPLATES_DIR, '2-git-main-only'), gitMainDir, {
    recursive: true,
  });
  execSync('git init -b main && git add . && git commit -m "initial commit"', {
    cwd: gitMainDir,
    env: ISOLATED_GIT_ENV,
    stdio: 'ignore',
  });

  // 3. Git workspace (feature branch + origin/main base)
  const gitFeatureDir = path.join(baseDir, '3-git-feature-branch');
  fs.mkdirSync(gitFeatureDir, { recursive: true });

  // Copy initial main branch files (excluding .feature files)
  const template3Dir = path.join(TEMPLATES_DIR, '3-git-feature-branch');
  fs.copyFileSync(
    path.join(template3Dir, 'main.ts'),
    path.join(gitFeatureDir, 'main.ts')
  );

  execSync('git init -b main && git add . && git commit -m "initial commit"', {
    cwd: gitFeatureDir,
    env: ISOLATED_GIT_ENV,
    stdio: 'ignore',
  });
  execSync('git remote add origin https://github.com/example/repo.git', {
    cwd: gitFeatureDir,
    env: ISOLATED_GIT_ENV,
    stdio: 'ignore',
  });
  execSync('git update-ref refs/remotes/origin/main HEAD', {
    cwd: gitFeatureDir,
    env: ISOLATED_GIT_ENV,
    stdio: 'ignore',
  });
  execSync('git checkout -b feature/auth', {
    cwd: gitFeatureDir,
    env: ISOLATED_GIT_ENV,
    stdio: 'ignore',
  });

  // Copy feature branch state file
  fs.copyFileSync(
    path.join(template3Dir, 'main.ts.feature'),
    path.join(gitFeatureDir, 'main.ts')
  );
  execSync('git add . && git commit -m "feat: add auth stub"', {
    cwd: gitFeatureDir,
    env: ISOLATED_GIT_ENV,
    stdio: 'ignore',
  });

  return baseDir;
}

// When called directly via `tsx tests/fixtures/setup-fixtures.ts`
if (require.main === module) {
  setupFixtures();
}

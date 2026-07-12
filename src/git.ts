// Git integration: commit info, merge-base, default branch, dirty check, and author identity.

import { execFile } from 'node:child_process';
import type * as vscode from 'vscode';

export interface CommitInfo {
  id: string;
  message: string;
}

export interface GitContext {
  getCommit(ref: string): Promise<CommitInfo>;
  getMergeBase(a: string, b: string): Promise<string | undefined>;
  getDefaultBranch(): Promise<string | undefined>;
  isDirty(): Promise<boolean>;
  getAuthor(): Promise<{ name: string; email?: string }>;
}

function git(
  cwd: string,
  ...args: string[]
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd }, (error, stdout, stderr) => {
      if (error) {
        reject(error);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

export async function getGitContext(
  workspaceFolder: vscode.Uri
): Promise<GitContext | undefined> {
  const cwd = workspaceFolder.fsPath;

  try {
    await git(cwd, 'rev-parse', '--is-inside-work-tree');
  } catch {
    return undefined;
  }

  return {
    async getCommit(ref: string): Promise<CommitInfo> {
      const { stdout } = await git(cwd, 'log', '-1', '--format=%H%n%s', ref);
      const [hash, ...messageParts] = stdout.trim().split('\n');
      return { id: hash, message: messageParts.join('\n') };
    },

    async getMergeBase(a: string, b: string): Promise<string | undefined> {
      try {
        const { stdout } = await git(cwd, 'merge-base', a, b);
        return stdout.trim() || undefined;
      } catch {
        return undefined;
      }
    },

    async getDefaultBranch(): Promise<string | undefined> {
      const candidates = ['origin/main', 'origin/master', 'origin/trunk'];
      for (const candidate of candidates) {
        try {
          await git(cwd, 'rev-parse', '--verify', candidate);
          return candidate;
        } catch {}
      }
      return undefined;
    },

    async isDirty(): Promise<boolean> {
      try {
        const { stdout } = await git(cwd, 'status', '--porcelain');
        return stdout.trim().length > 0;
      } catch {
        return false;
      }
    },

    async getAuthor(): Promise<{ name: string; email?: string }> {
      const { stdout: nameOut } = await git(
        cwd,
        'config',
        '--get',
        'user.name'
      );
      const name = nameOut.trim();
      try {
        const { stdout: emailOut } = await git(
          cwd,
          'config',
          '--get',
          'user.email'
        );
        return { name, email: emailOut.trim() || undefined };
      } catch {
        return { name };
      }
    },
  };
}

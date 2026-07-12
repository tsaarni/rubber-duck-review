import * as os from 'node:os';
import * as vscode from 'vscode';

/**
 * Get the current user's name and email for authoring comments.
 * Tries VS Code git settings first, then OS username, then environment variables.
 */
export function getCurrentAuthor(): { name: string; email?: string } {
  const cfg = vscode.workspace.getConfiguration();
  const name = cfg.get<string>('git.userName');
  const email = cfg.get<string>('git.userEmail');

  if (name) {
    return { name, email };
  }

  // Fall back to OS username (cross-platform)
  try {
    const username = os.userInfo().username;
    if (username) {
      return { name: username, email };
    }
  } catch {}

  // Last resort: environment variables
  const fallbackName =
    process.env.USER ||
    process.env.LOGNAME ||
    process.env.USERNAME ||
    'Unknown';
  return { name: fallbackName, email };
}

import type * as vscode from 'vscode';

class Logger {
  private channel: vscode.LogOutputChannel | undefined;

  init(channel: vscode.LogOutputChannel): void {
    this.channel = channel;
  }

  trace(message: string): void {
    this.channel?.trace(message);
  }

  debug(message: string): void {
    this.channel?.debug(message);
  }

  info(message: string): void {
    this.channel?.info(message);
  }

  warn(message: string): void {
    this.channel?.warn(message);
  }

  error(message: string): void {
    this.channel?.error(message);
  }
}

export const logger = new Logger();

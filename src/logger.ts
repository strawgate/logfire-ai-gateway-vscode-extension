import * as vscode from "vscode";

let outputChannel: vscode.LogOutputChannel | undefined;

export function initializeLogger(): vscode.Disposable {
  outputChannel = vscode.window.createOutputChannel("Logfire AI Gateway", {
    log: true,
  });
  return outputChannel;
}

export const logger = {
  info(message: string, ...args: unknown[]) {
    outputChannel?.info(message, ...args);
  },
  warn(message: string, ...args: unknown[]) {
    outputChannel?.warn(message, ...args);
  },
  error(message: string, ...args: unknown[]) {
    outputChannel?.error(message, ...args);
  },
  debug(message: string, ...args: unknown[]) {
    outputChannel?.debug(message, ...args);
  },
};

export function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return "Unknown error occurred";
}

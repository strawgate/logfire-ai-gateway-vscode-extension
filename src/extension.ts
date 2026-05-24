import * as vscode from "vscode";
import { LogfireAuthenticationProvider } from "./auth";
import { EXTENSION_ID } from "./constants";
import { initializeLogger, logger } from "./logger";
import { LogfireGatewayChatModelProvider } from "./provider";

export function activate(context: vscode.ExtensionContext) {
  const loggerDisposable = initializeLogger();
  context.subscriptions.push(loggerDisposable);

  logger.info("Logfire AI Gateway extension activating...");

  const authProvider = new LogfireAuthenticationProvider(context);
  context.subscriptions.push(authProvider);

  const provider = new LogfireGatewayChatModelProvider(authProvider);
  context.subscriptions.push(provider);
  const providerDisposable = vscode.lm.registerLanguageModelChatProvider(
    EXTENSION_ID,
    provider,
  );
  context.subscriptions.push(providerDisposable);

  // Fire the change event so VS Code knows to call provideLanguageModelChatInformation.
  // Without this signal VS Code won't discover models until a chat is opened.
  provider.signalModelsReady();

  const commandDisposable = vscode.commands.registerCommand(
    `${EXTENSION_ID}.manage`,
    () => {
      authProvider.manageAuthentication();
    },
  );
  context.subscriptions.push(commandDisposable);

  logger.info("Logfire AI Gateway extension activated successfully");

  return { authProvider };
}

export function deactivate() {
  logger.info("Logfire AI Gateway extension deactivating...");
}

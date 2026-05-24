import * as vscode from "vscode";
import { DEFAULT_BASE_URL, DEFAULT_TIMEOUT_MS, EXTENSION_ID } from "./constants";

export function getConfig() {
  const config = vscode.workspace.getConfiguration(EXTENSION_ID);
  return {
    endpoint: config.get("endpoint", DEFAULT_BASE_URL),
    timeout: config.get("timeout", DEFAULT_TIMEOUT_MS),
  };
}

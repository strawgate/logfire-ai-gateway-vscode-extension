import * as vscode from "vscode";
import { DEFAULT_BASE_URL, DEFAULT_TIMEOUT_MS, EXTENSION_ID } from "./constants";

export interface ModelOverride {
  contextWindow?: number;
  maxOutputTokens?: number;
  toolCalling?: boolean;
  vision?: boolean;
}

export function getConfig() {
  const config = vscode.workspace.getConfiguration(EXTENSION_ID);
  return {
    endpoint: config.get("endpoint", DEFAULT_BASE_URL),
    timeout: config.get("timeout", DEFAULT_TIMEOUT_MS),
    modelOverrides: config.get<Record<string, ModelOverride>>("modelOverrides", {}),
  };
}

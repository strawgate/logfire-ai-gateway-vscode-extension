import { defineConfig } from "@vscode/test-cli";

export default defineConfig([
  {
    label: "VS Code E2E Tests",
    files: "out/test-vscode/**/*.test.js",
    version: "stable",
    workspaceFolder: ".",
    mocha: {
      timeout: 30000,
    },
    // Do NOT use --disable-extensions: the extension under test must be able to load
  },
]);

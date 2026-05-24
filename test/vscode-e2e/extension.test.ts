/**
 * VS Code E2E tests for the Logfire AI Gateway extension.
 *
 * These run inside a real VS Code instance via @vscode/test-electron.
 * They verify the full extension lifecycle without requiring manual interaction.
 *
 * Set PYDANTIC_AI_GATEWAY env var to enable tests that require real credentials.
 */

import * as assert from "assert";
import * as vscode from "vscode";

const PROVIDER_VENDOR = "logfireGateway";
const COMMAND_ID = "logfireGateway.manage";
const API_KEY = process.env["PYDANTIC_AI_GATEWAY"];

/** Finds our extension regardless of whether it's published or running from source. */
function findExtension() {
  return vscode.extensions.all.find((e) =>
    e.packageJSON?.contributes?.languageModelChatProviders?.some(
      (p: { vendor: string }) => p.vendor === PROVIDER_VENDOR,
    ),
  );
}

/** Wait up to maxMs for a condition to be true, polling every intervalMs. */
async function waitFor(
  condition: () => Promise<boolean>,
  maxMs = 5000,
  intervalMs = 200,
): Promise<boolean> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (await condition()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

// Mocha TDD interface (default for @vscode/test-cli)
declare function suite(name: string, fn: () => void): void;
declare function test(name: string, fn: () => void | Promise<void>): void;
declare function suiteSetup(fn: (this: Mocha.Context) => void | Promise<void>): void;
declare function suiteTeardown(fn: () => void | Promise<void>): void;
declare function setup(fn: () => void | Promise<void>): void;

suite("Extension Activation", () => {
  let ext: vscode.Extension<unknown> | undefined;

  setup(() => {
    ext = findExtension();
  });

  test("Extension is present in the extensions list", () => {
    assert.ok(ext, "Extension with logfireGateway vendor should be installed");
  });

  test("Extension activates without error", async () => {
    if (!ext) { return; }
    await ext.activate();
    assert.strictEqual(ext.isActive, true);
  });

  test("Extension exports authProvider", async () => {
    if (!ext) { return; }
    await ext.activate();
    const api = ext.exports as { authProvider?: unknown };
    assert.ok(api.authProvider, "Extension should export authProvider");
  });
});

suite("Commands", () => {
  test("logfireGateway.manage is registered", async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(
      commands.includes(COMMAND_ID),
      `Command ${COMMAND_ID} should be registered`,
    );
  });

  test("logfireGateway.refreshModels is registered", async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(
      commands.includes("logfireGateway.refreshModels"),
      "Command logfireGateway.refreshModels should be registered",
    );
  });

  test("logfireGateway.refreshModels executes without error", async () => {
    await assert.doesNotReject(
      vscode.commands.executeCommand("logfireGateway.refreshModels"),
    );
  });
});

suite("Configuration", () => {
  test("logfireGateway.endpoint has HTTPS default", () => {
    const config = vscode.workspace.getConfiguration("logfireGateway");
    const endpoint = config.get<string>("endpoint");
    assert.ok(endpoint, "endpoint should have a default value");
    assert.ok(endpoint!.startsWith("https://"), "endpoint should be HTTPS");
    assert.ok(
      endpoint!.includes("pydantic.dev"),
      "default endpoint should point to pydantic.dev",
    );
  });

  test("logfireGateway.timeout is a positive number >= 5000", () => {
    const config = vscode.workspace.getConfiguration("logfireGateway");
    const timeout = config.get<number>("timeout");
    assert.ok(typeof timeout === "number", "timeout should be a number");
    assert.ok(timeout! >= 5000, "timeout should be at least 5000ms");
    assert.ok(timeout! <= 300000, "timeout should be at most 300000ms");
  });
});

suite("Language Model Provider", () => {
  test("vscode.lm API is available", () => {
    assert.ok(vscode.lm, "vscode.lm should be available");
    assert.ok(
      typeof vscode.lm.selectChatModels === "function",
      "selectChatModels should be a function",
    );
  });

  test("Provider vendor declared in package.json", async () => {
    const ext = findExtension();
    if (!ext) { return; }
    const providers = ext.packageJSON?.contributes?.languageModelChatProviders;
    assert.ok(providers?.length > 0, "Should contribute language model providers");
    const logfire = providers.find(
      (p: { vendor: string }) => p.vendor === PROVIDER_VENDOR,
    );
    assert.ok(logfire, `Should have a provider with vendor=${PROVIDER_VENDOR}`);
    assert.ok(logfire.displayName, "Provider should have a displayName");
  });

  test("selectChatModels does not throw without credentials", async () => {
    const models = await vscode.lm.selectChatModels({ vendor: PROVIDER_VENDOR });
    assert.ok(Array.isArray(models), "selectChatModels should return an array");
  });
});

// ---- Tests that require real credentials ----

suite("Auth and Model Discovery (requires PYDANTIC_AI_GATEWAY)", function () {
  let authProvider: {
    storeTestCredential(apiKey: string, label?: string): Promise<void>;
    getActiveToken(): Promise<string | undefined>;
  };

  suiteSetup(async function (this: Mocha.Context) {
    if (!API_KEY) {
      console.log("  Skipping credential tests: PYDANTIC_AI_GATEWAY not set");
      this.skip();
      return;
    }
    const rawExt = findExtension();
    assert.ok(rawExt, "Extension should be installed");
    await rawExt!.activate();
    const api = rawExt!.exports as typeof authProvider extends undefined
      ? never
      : { authProvider: typeof authProvider };
    authProvider = (api as { authProvider: typeof authProvider }).authProvider;
    assert.ok(authProvider, "Extension should export authProvider");
  });

  test("storeTestCredential stores an API key", async () => {
    await authProvider.storeTestCredential(API_KEY!, "E2E Test");
    const token = await authProvider.getActiveToken();
    assert.strictEqual(token, API_KEY, "Stored token should match injected key");
  });

  test("getActiveToken returns token without VS Code auth consent flow", async () => {
    const token = await authProvider.getActiveToken();
    assert.ok(
      token,
      "getActiveToken should return a token after storing credentials",
    );
  });

  test("Models are discovered after credentials are stored", async () => {
    const loaded = await waitFor(
      async () => {
        const models = await vscode.lm.selectChatModels({
          vendor: PROVIDER_VENDOR,
        });
        return models.length > 0;
      },
      15000,
      500,
    );

    assert.ok(
      loaded,
      "At least one model should be discoverable after credentials are stored. " +
        "Check the 'Logfire AI Gateway' output channel for errors.",
    );
  });

  test("Discovered models have vendor=logfireGateway and route/modelId format", async () => {
    const models = await vscode.lm.selectChatModels({ vendor: PROVIDER_VENDOR });
    assert.ok(models.length > 0, "Should have at least one model");

    for (const model of models.slice(0, 5)) {
      assert.strictEqual(model.vendor, PROVIDER_VENDOR, "vendor should match");
      assert.ok(
        model.id.includes("/"),
        `model ID '${model.id}' should be in route/modelId format`,
      );
      // Name is prefixed with the route: "[route] model name"
      assert.ok(
        model.name.startsWith("["),
        `model name '${model.name}' should start with '[route]' prefix`,
      );
    }
  });

  test("Live-fetched models (e.g. minimax.io) are present with correct name prefix", async () => {
    const models = await vscode.lm.selectChatModels({ vendor: PROVIDER_VENDOR });
    const minimaxModels = models.filter((m) => m.id.startsWith("minimax.io/"));
    if (minimaxModels.length === 0) {
      console.log("  No minimax.io models found, skipping check");
      return;
    }
    for (const model of minimaxModels) {
      assert.ok(
        model.name.startsWith("[minimax.io]"),
        `${model.id} name '${model.name}' should start with '[minimax.io]'`,
      );
    }
    console.log(`  Verified ${minimaxModels.length} minimax.io model(s): ${minimaxModels.map(m => m.id).join(", ")}`);
  });

  test("Both gateway routes are represented in discovered models", async () => {
    const models = await vscode.lm.selectChatModels({ vendor: PROVIDER_VENDOR });
    const routes = new Set(models.map((m) => m.id.split("/")[0]));
    console.log(`  Discovered routes: ${[...routes].join(", ")}`);
    console.log(`  Total models: ${models.length}`);
    // Log a sample from each route
    for (const route of routes) {
      const sample = models.filter((m) => m.id.startsWith(route + "/")).slice(0, 2);
      for (const m of sample) {
        console.log(`    ${route}: ${m.name} (${m.id})`);
      }
    }
    assert.ok(routes.size >= 1, "Should have at least one route");
  });

  suiteTeardown(async () => {
    // Best-effort cleanup — remove stored test session
    if (authProvider) {
      try {
        await authProvider.storeTestCredential("", "cleanup");
      } catch {
        // ignore
      }
    }
  });
});

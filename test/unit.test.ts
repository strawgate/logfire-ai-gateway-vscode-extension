/**
 * Unit tests for the extension's core logic with mocked vscode module.
 *
 * Tests the message conversion, model transformation, tool building,
 * and streaming logic without needing a live VS Code instance or gateway.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// --- Mock vscode module ---
vi.mock("vscode", () => {
  class MockEventEmitter {
    private listeners: Array<(...args: unknown[]) => void> = [];
    event = (listener: (...args: unknown[]) => void) => {
      this.listeners.push(listener);
      return { dispose: () => {} };
    };
    fire(...args: unknown[]) {
      for (const l of this.listeners) l(...args);
    }
    dispose() {
      this.listeners = [];
    }
  }

  class MockLanguageModelTextPart {
    readonly value: string;
    constructor(value: string) {
      this.value = value;
    }
  }

  class MockLanguageModelToolCallPart {
    readonly callId: string;
    readonly name: string;
    readonly input: unknown;
    constructor(callId: string, name: string, input: unknown) {
      this.callId = callId;
      this.name = name;
      this.input = input;
    }
  }

  class MockLanguageModelToolResultPart {
    readonly callId: string;
    readonly content: Array<{ value: string }>;
    constructor(callId: string, content: Array<{ value: string }>) {
      this.callId = callId;
      this.content = content;
    }
  }

  class MockLanguageModelDataPart {
    readonly mimeType: string;
    readonly data: Uint8Array;
    constructor(data: Uint8Array, mimeType: string) {
      this.data = data;
      this.mimeType = mimeType;
    }
  }

  return {
    EventEmitter: MockEventEmitter,
    LanguageModelTextPart: MockLanguageModelTextPart,
    LanguageModelToolCallPart: MockLanguageModelToolCallPart,
    LanguageModelToolResultPart: MockLanguageModelToolResultPart,
    LanguageModelDataPart: MockLanguageModelDataPart,
    LanguageModelChatMessageRole: {
      User: 1,
      Assistant: 2,
    },
    LanguageModelChatToolMode: {
      Auto: 1,
      Required: 2,
    },
    authentication: {
      getSession: vi.fn(),
      onDidChangeSessions: vi.fn(() => ({ dispose: () => {} })),
    },
    window: {
      showErrorMessage: vi.fn(),
      showInformationMessage: vi.fn(),
      showQuickPick: vi.fn(),
      showInputBox: vi.fn(),
      createOutputChannel: vi.fn(() => ({
        appendLine: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        dispose: vi.fn(),
      })),
    },
    workspace: {
      getConfiguration: vi.fn(() => ({
        get: vi.fn((key: string, defaultVal: unknown) => defaultVal),
      })),
    },
    lm: {
      registerLanguageModelChatProvider: vi.fn(() => ({ dispose: () => {} })),
    },
    commands: {
      registerCommand: vi.fn(() => ({ dispose: () => {} })),
    },
  };
});

// Now import the modules under test (after mock is set up)
import {
  LanguageModelTextPart,
  LanguageModelToolCallPart,
  LanguageModelToolResultPart,
  LanguageModelDataPart,
  LanguageModelChatMessageRole,
  LanguageModelChatToolMode,
} from "vscode";

import {
  API_TYPE_CHAT_PATHS,
  DEFAULT_CHAT_PATH,
  EXTENSION_ID,
  DEFAULT_BASE_URL,
  MODELS_ENDPOINT,
  DEEPSEEK_TOOLS_LIMIT,
} from "../src/constants";

import { getModelRouteInfo, ModelsClient } from "../src/models";

// ---- Constants tests ----

describe("Constants", () => {
  it("EXTENSION_ID is logfireGateway", () => {
    expect(EXTENSION_ID).toBe("logfireGateway");
  });

  it("DEFAULT_BASE_URL is the US gateway", () => {
    expect(DEFAULT_BASE_URL).toBe("https://gateway-us.pydantic.dev/proxy");
  });

  it("MODELS_ENDPOINT is /models", () => {
    expect(MODELS_ENDPOINT).toBe("/models");
  });

  it("anthropic API type uses v1/messages", () => {
    expect(API_TYPE_CHAT_PATHS["anthropic"]).toBe("v1/messages");
  });

  it("openai API type uses chat/completions", () => {
    expect(API_TYPE_CHAT_PATHS["openai"]).toBe("chat/completions");
  });

  it("DEFAULT_CHAT_PATH is chat/completions", () => {
    expect(DEFAULT_CHAT_PATH).toBe("chat/completions");
  });

  it("all known API types have a chat path", () => {
    for (const [, path] of Object.entries(API_TYPE_CHAT_PATHS)) {
      expect(path).toBeTruthy();
      expect(path).toMatch(/^(v1\/)?(chat\/completions|messages)$/);
    }
  });
});

// ---- Model transformation tests ----

describe("ModelsClient transformation", () => {
  // Static /models response — uses genai-prices catalog (may have wrong models for some routes)
  const mockStaticModelsResponse = [
    {
      route: "opencode-openai",
      provider: "openai",
      models: [
        { id: "gpt-4o", name: "GPT-4o", context_window: 128000 },
        { id: "o4-mini", name: "O4 Mini", context_window: 200000 },
      ],
    },
    {
      route: "minimax.io",
      provider: "anthropic",
      // Static data has wrong models (genai-prices maps anthropic→Claude)
      // — the live fetch replaces these
      models: [{ id: "claude-3-5-sonnet-20241022", name: "Claude 3.5 Sonnet", context_window: 200000 }],
    },
  ];

  // Live response from GET /minimax.io/v1/models — actual provider models
  const mockLiveMinimaxModels = {
    data: [
      { id: "MiniMax-M2.7", display_name: "MiniMax M2.7" },
      { id: "MiniMax-M2.7-highspeed", display_name: "MiniMax M2.7 Highspeed" },
    ],
  };

  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (typeof url === "string" && url.includes("minimax.io/v1/models")) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(mockLiveMinimaxModels) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve(mockStaticModelsResponse) });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("should transform models with route/modelId format", async () => {
    const client = new ModelsClient();
    const models = await client.getModels("test-api-key");

    // 2 openai + 2 live minimax models (live data replaces static claude models)
    expect(models.length).toBe(4);
    expect(models[0].id).toBe("opencode-openai/gpt-4o");
    expect(models[1].id).toBe("opencode-openai/o4-mini");
    expect(models[2].id).toBe("minimax.io/MiniMax-M2.7");
    expect(models[3].id).toBe("minimax.io/MiniMax-M2.7-highspeed");
  });

  it("should set names from the gateway response", async () => {
    const client = new ModelsClient();
    const models = await client.getModels("test-api-key");

    expect(models[0].name).toBe("[opencode-openai] GPT-4o");
    // Live minimax models replace static Claude ones
    expect(models[2].name).toBe("[minimax.io] MiniMax M2.7");
    expect(models[3].name).toBe("[minimax.io] MiniMax M2.7 Highspeed");
  });

  it("should populate the model route map", async () => {
    const client = new ModelsClient();
    await client.getModels("test-api-key");

    const routeInfo = getModelRouteInfo("opencode-openai/gpt-4o");
    expect(routeInfo).toBeDefined();
    expect(routeInfo!.route).toBe("opencode-openai");
    expect(routeInfo!.apiType).toBe("openai");
    expect(routeInfo!.chatPath).toBe("chat/completions");
  });

  it("should use v1/messages for anthropic-type routes (e.g. minimax.io)", async () => {
    const client = new ModelsClient();
    await client.getModels("test-api-key");

    const routeInfo = getModelRouteInfo("minimax.io/MiniMax-M2.7");
    expect(routeInfo).toBeDefined();
    expect(routeInfo!.apiType).toBe("anthropic");
    expect(routeInfo!.chatPath).toBe("v1/messages");
  });

  it("should detect capabilities from model ID patterns", async () => {
    const client = new ModelsClient();
    const models = await client.getModels("test-api-key");

    // gpt-4o should have vision and tool calling
    const gpt4o = models.find((m) => m.id === "opencode-openai/gpt-4o")!;
    expect(gpt4o.capabilities.imageInput).toBe(true);
    expect(gpt4o.capabilities.toolCalling).toBe(true);

    // Live-fetched models (from /v1/models endpoint) get toolCalling=true by default
    // even when the model ID doesn't match known patterns, because the Anthropic
    // Messages API inherently supports tool use.
    const minimax = models.find((m) => m.id === "minimax.io/MiniMax-M2.7")!;
    expect(minimax).toBeDefined();
    expect(minimax.capabilities.toolCalling).toBe(true);
  });

  it("should set detail to identify Logfire Gateway", async () => {
    const client = new ModelsClient();
    const models = await client.getModels("test-api-key");

    expect(models[0].detail).toBe("Logfire Gateway");
    expect(models[2].detail).toBe("Logfire Gateway");
  });

  it("should cache results on subsequent calls", async () => {
    const client = new ModelsClient();
    await client.getModels("test-api-key");
    await client.getModels("test-api-key");

    // 3 fetches per getModels call (1 static + 1 live anthropic + 1 live openai), but only once due to cache
    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
  });

  it("should re-fetch after cache invalidation", async () => {
    const client = new ModelsClient();
    await client.getModels("test-api-key");
    client.invalidateCache();
    await client.getModels("test-api-key");

    // 3 fetches per getModels call × 2 calls = 6
    expect(globalThis.fetch).toHaveBeenCalledTimes(6);
  });

  it("should throw on HTTP errors from gateway", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
    }) as unknown as typeof fetch;

    const client = new ModelsClient();
    await expect(client.getModels("bad-key")).rejects.toThrow("401");
  });
});

// ---- Message conversion tests ----
// We test the conversion function indirectly by importing from provider
// Since convertMessages is not exported, we test it through the provider class
// or by extracting it. For now, test the convertible scenarios via integration.

describe("Message types (mock verification)", () => {
  it("LanguageModelTextPart captures text value", () => {
    const part = new LanguageModelTextPart("hello");
    expect(part.value).toBe("hello");
  });

  it("LanguageModelToolCallPart captures call details", () => {
    const part = new LanguageModelToolCallPart("call_1", "get_weather", {
      location: "SF",
    });
    expect(part.callId).toBe("call_1");
    expect(part.name).toBe("get_weather");
    expect(part.input).toEqual({ location: "SF" });
  });

  it("LanguageModelToolResultPart captures result content", () => {
    const part = new LanguageModelToolResultPart("call_1", [
      { value: "72°F" },
    ]);
    expect(part.callId).toBe("call_1");
    expect(part.content[0].value).toBe("72°F");
  });

  it("LanguageModelDataPart captures binary data", () => {
    const data = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const part = new LanguageModelDataPart(data, "image/png");
    expect(part.mimeType).toBe("image/png");
    expect(part.data).toEqual(data);
  });

  it("LanguageModelChatMessageRole has User and Assistant", () => {
    expect(LanguageModelChatMessageRole.User).toBe(1);
    expect(LanguageModelChatMessageRole.Assistant).toBe(2);
  });

  it("LanguageModelChatToolMode has Auto and Required", () => {
    expect(LanguageModelChatToolMode.Auto).toBe(1);
    expect(LanguageModelChatToolMode.Required).toBe(2);
  });
});

// ---- Provider construction tests ----

describe("LogfireGatewayChatModelProvider", () => {
  it("should be importable", async () => {
    const { LogfireGatewayChatModelProvider } = await import(
      "../src/provider"
    );
    expect(LogfireGatewayChatModelProvider).toBeDefined();
  });

  it("should be constructable", async () => {
    const { LogfireGatewayChatModelProvider } = await import(
      "../src/provider"
    );
    const provider = new LogfireGatewayChatModelProvider();
    expect(provider).toBeDefined();
    expect(provider.onDidChangeLanguageModelChatInformation).toBeDefined();
    provider.dispose();
  });
});

// ---- Extension activation test ----

describe("Extension activation", () => {
  it("activate function should be exported", async () => {
    const ext = await import("../src/extension");
    expect(ext.activate).toBeDefined();
    expect(ext.deactivate).toBeDefined();
    expect(typeof ext.activate).toBe("function");
    expect(typeof ext.deactivate).toBe("function");
  });
});

// ---- Reasoning marker round-trip tests ----

describe("Reasoning marker (DeepSeek thinking mode)", () => {
  const makeMsg = (
    role: number,
    content: unknown[],
  ) => ({ role, content });

  it("injects reasoning_content from marker on assistant turns", async () => {
    const { convertToOpenAIMessages, REASONING_MARKER_MIME } = await import(
      "../src/provider"
    );
    const reasoningText = "I think step by step...";
    const marker = new LanguageModelDataPart(
      Buffer.from(reasoningText, "utf-8"),
      REASONING_MARKER_MIME,
    );
    const messages = [
      makeMsg(LanguageModelChatMessageRole.User, [new LanguageModelTextPart("What is 2+2?")]),
      makeMsg(
        LanguageModelChatMessageRole.Assistant,
        [new LanguageModelTextPart("Sure, here is the answer."), marker],
      ),
      makeMsg(LanguageModelChatMessageRole.User, [new LanguageModelTextPart("Follow up")]),
    ];

    const result = convertToOpenAIMessages(messages as never, true);
    const assistantMsg = result.find((m) => m.role === "assistant");
    expect(assistantMsg).toBeDefined();
    expect((assistantMsg as Record<string, unknown>).reasoning_content).toBe(reasoningText);
  });

  it("falls back to empty string when prior turn has no marker (thinking conversation)", async () => {
    const { convertToOpenAIMessages, REASONING_MARKER_MIME } = await import("../src/provider");
    // Turn 1 had reasoning (marker present), turn 2 did not.
    // Both must get reasoning_content because injectReasoningContent=true (DeepSeek).
    const marker = new LanguageModelDataPart(
      Buffer.from("some reasoning", "utf-8"),
      REASONING_MARKER_MIME,
    );
    const messages = [
      makeMsg(LanguageModelChatMessageRole.User, [new LanguageModelTextPart("Hello")]),
      makeMsg(
        LanguageModelChatMessageRole.Assistant,
        [new LanguageModelTextPart("First answer."), marker],
      ),
      makeMsg(LanguageModelChatMessageRole.User, [new LanguageModelTextPart("Next question")]),
      makeMsg(
        LanguageModelChatMessageRole.Assistant,
        [new LanguageModelTextPart("Plain response without reasoning.")],
      ),
    ];

    const result = convertToOpenAIMessages(messages as never, true);
    const assistantMsgs = result.filter((m) => m.role === "assistant");
    expect(assistantMsgs).toHaveLength(2);
    // Turn 1 assistant: had marker — gets the actual reasoning text
    expect((assistantMsgs[0] as Record<string, unknown>).reasoning_content).toBe("some reasoning");
    // Turn 2 assistant: no marker — falls back to ""
    expect((assistantMsgs[1] as Record<string, unknown>).reasoning_content).toBe("");
  });

  it("does not inject reasoning_content for non-thinking conversations", async () => {
    const { convertToOpenAIMessages } = await import("../src/provider");
    // No reasoning markers anywhere and injectReasoningContent=false (default).
    const messages = [
      makeMsg(LanguageModelChatMessageRole.User, [new LanguageModelTextPart("Hello")]),
      makeMsg(
        LanguageModelChatMessageRole.Assistant,
        [new LanguageModelTextPart("Standard model response.")],
      ),
    ];

    const result = convertToOpenAIMessages(messages as never);
    const assistantMsg = result.find((m) => m.role === "assistant");
    expect(assistantMsg).toBeDefined();
    // injectReasoningContent=false (default, non-DeepSeek model) — must NOT inject.
    expect((assistantMsg as Record<string, unknown>).reasoning_content).toBeUndefined();
  });

  it("injects reasoning_content on first DeepSeek turn even without a prior marker", async () => {
    const { convertToOpenAIMessages } = await import("../src/provider");
    // Simulates a brand-new DeepSeek thinking-model conversation: no prior assistant
    // messages with markers yet, but caller passes injectReasoningContent=true because
    // it knows the model is DeepSeek. The assistant turn must get reasoning_content: "".
    const messages = [
      makeMsg(LanguageModelChatMessageRole.User, [new LanguageModelTextPart("Hello")]),
      makeMsg(
        LanguageModelChatMessageRole.Assistant,
        [new LanguageModelTextPart("Answer without marker.")],
      ),
    ];

    const result = convertToOpenAIMessages(messages as never, true);
    const assistantMsg = result.find((m) => m.role === "assistant");
    expect(assistantMsg).toBeDefined();
    expect((assistantMsg as Record<string, unknown>).reasoning_content).toBe("");
  });

  it("does not set reasoning_content on user or tool messages", async () => {
    const { convertToOpenAIMessages } = await import("../src/provider");
    const messages = [
      makeMsg(LanguageModelChatMessageRole.User, [new LanguageModelTextPart("Hello")]),
    ];

    const result = convertToOpenAIMessages(messages as never);
    const userMsg = result.find((m) => m.role === "user");
    expect(userMsg).toBeDefined();
    expect((userMsg as Record<string, unknown>).reasoning_content).toBeUndefined();
  });

  it("skips reasoning marker DataPart — does not emit it as an image message", async () => {
    const { convertToOpenAIMessages, REASONING_MARKER_MIME } = await import(
      "../src/provider"
    );
    const marker = new LanguageModelDataPart(
      Buffer.from("think"),
      REASONING_MARKER_MIME,
    );
    const messages = [
      makeMsg(LanguageModelChatMessageRole.User, [new LanguageModelTextPart("hi")]),
      makeMsg(
        LanguageModelChatMessageRole.Assistant,
        [new LanguageModelTextPart("answer"), marker],
      ),
    ];

    const result = convertToOpenAIMessages(messages as never);
    // Two messages: the user turn + the assistant turn (marker must NOT produce a 3rd image message)
    expect(result).toHaveLength(2);
    expect(result[1].role).toBe("assistant");
  });

  it("attaches reasoning_content to tool_calls assistant message", async () => {
    const { convertToOpenAIMessages, REASONING_MARKER_MIME } = await import(
      "../src/provider"
    );
    const reasoningText = "planning tool call";
    const marker = new LanguageModelDataPart(
      Buffer.from(reasoningText, "utf-8"),
      REASONING_MARKER_MIME,
    );
    const messages = [
      makeMsg(LanguageModelChatMessageRole.Assistant, [
        new LanguageModelToolCallPart("call_1", "search", { query: "x" }),
        marker,
      ]),
    ];

    const result = convertToOpenAIMessages(messages as never, true);
    const assistantMsg = result.find((m) => m.role === "assistant");
    expect(assistantMsg).toBeDefined();
    expect((assistantMsg as Record<string, unknown>).reasoning_content).toBe(reasoningText);
  });

  it("consolidates multiple tool calls into a single assistant message", async () => {
    const { convertToOpenAIMessages } = await import("../src/provider");
    const messages = [
      makeMsg(LanguageModelChatMessageRole.User, [new LanguageModelTextPart("Run two tools")]),
      makeMsg(LanguageModelChatMessageRole.Assistant, [
        new LanguageModelToolCallPart("call_1", "search", { query: "a" }),
        new LanguageModelToolCallPart("call_2", "lookup", { id: 42 }),
      ]),
    ];

    const result = convertToOpenAIMessages(messages as never);
    const assistantMsgs = result.filter((m) => m.role === "assistant");
    // Must be exactly ONE assistant message containing BOTH tool calls.
    expect(assistantMsgs).toHaveLength(1);
    const toolCalls = (assistantMsgs[0] as Record<string, unknown>).tool_calls as unknown[];
    expect(toolCalls).toHaveLength(2);
    expect((toolCalls[0] as { id: string }).id).toBe("call_1");
    expect((toolCalls[1] as { id: string }).id).toBe("call_2");
  });
});

// ---- safeStringify tests ----

describe("safeStringify", () => {
  it("serializes normal objects without modification", async () => {
    const { safeStringify } = await import("../src/utils");
    expect(safeStringify({ a: 1, b: "hello" })).toBe('{"a":1,"b":"hello"}');
  });

  it("replaces lone high surrogate with replacement character", async () => {
    const { safeStringify } = await import("../src/utils");
    // \uD800 is an unpaired high surrogate — JSON.stringify would throw or corrupt
    const input = { key: "before\uD800after" };
    const result = safeStringify(input);
    expect(result).toBe('{"key":"before\uFFFDafter"}');
  });

  it("replaces lone low surrogate with replacement character", async () => {
    const { safeStringify } = await import("../src/utils");
    const input = { key: "\uDC00lone" };
    const result = safeStringify(input);
    expect(result).toBe('{"key":"\uFFFDlone"}');
  });

  it("preserves valid surrogate pairs (emoji)", async () => {
    const { safeStringify } = await import("../src/utils");
    // 😀 = U+1F600 encoded as surrogate pair \uD83D\uDE00
    const input = { emoji: "😀" };
    const result = safeStringify(input);
    expect(result).toBe('{"emoji":"😀"}');
  });

  it("handles nested objects with lone surrogates", async () => {
    const { safeStringify } = await import("../src/utils");
    const input = { outer: { inner: "bad\uD83Dchar" } };
    const result = JSON.parse(safeStringify(input)) as { outer: { inner: string } };
    expect(result.outer.inner).toBe("bad\uFFFDchar");
  });
});

// ---- DeepSeek tools limit tests ----

describe("buildOpenAITools (DeepSeek 128-tool limit)", () => {
  it("DEEPSEEK_TOOLS_LIMIT constant is 128", () => {
    expect(DEEPSEEK_TOOLS_LIMIT).toBe(128);
  });

  it("accepts up to 128 tools for DeepSeek models", async () => {
    const { buildOpenAITools } = await import("../src/provider");
    const tools = Array.from({ length: 128 }, (_, i) => ({
      name: `tool_${i}`,
      description: "a tool",
      inputSchema: { type: "object", properties: {} },
    }));
    expect(() => buildOpenAITools(tools, "deepseek-r1")).not.toThrow();
  });

  it("throws when >128 tools sent to a DeepSeek model", async () => {
    const { buildOpenAITools } = await import("../src/provider");
    const tools = Array.from({ length: 129 }, (_, i) => ({
      name: `tool_${i}`,
      description: "a tool",
      inputSchema: { type: "object", properties: {} },
    }));
    expect(() => buildOpenAITools(tools, "deepseek-r1-0528")).toThrow(
      /DeepSeek models support at most 128 tools/,
    );
  });

  it("does not enforce the limit for non-DeepSeek models", async () => {
    const { buildOpenAITools } = await import("../src/provider");
    const tools = Array.from({ length: 200 }, (_, i) => ({
      name: `tool_${i}`,
      description: "a tool",
      inputSchema: { type: "object", properties: {} },
    }));
    expect(() => buildOpenAITools(tools, "gpt-4o")).not.toThrow();
  });
});

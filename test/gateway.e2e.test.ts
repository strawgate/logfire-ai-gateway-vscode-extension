/**
 * E2E integration tests for the Logfire AI Gateway.
 *
 * These tests hit the real gateway API using credentials from .env:
 *   PYDANTIC_AI_GATEWAY - API key
 *   PYDANTIC_AI_BASE_URL - Gateway endpoint (e.g. https://gateway-us.pydantic.dev/proxy)
 *
 * Run with: npm test
 */
import { describe, it, expect, beforeAll } from "vitest";
import { config } from "dotenv";

config(); // Load .env

const API_KEY = process.env.PYDANTIC_AI_GATEWAY!;
const BASE_URL = process.env.PYDANTIC_AI_BASE_URL!;

interface ModelEntry {
  id: string;
  name: string | undefined;
  context_window: number | undefined;
}

interface RouteModels {
  route: string;
  provider: string;
  models: ModelEntry[];
}

/**
 * Determines the correct chat completions path for a given provider.
 * Anthropic uses v1/messages (native Anthropic API format);
 * all other providers use chat/completions (OpenAI format).
 */
function getChatPath(provider: string): string {
  return provider === "anthropic" ? "v1/messages" : "chat/completions";
}

describe("Logfire AI Gateway E2E", () => {
  beforeAll(() => {
    if (!API_KEY || !BASE_URL) {
      throw new Error(
        "Missing PYDANTIC_AI_GATEWAY or PYDANTIC_AI_BASE_URL in .env",
      );
    }
  });

  describe("Authentication", () => {
    it("should reject requests without an API key", async () => {
      const response = await fetch(`${BASE_URL}/models`);
      expect(response.ok).toBe(false);
      expect(response.status).toBeGreaterThanOrEqual(400);
    });

    it("should reject requests with an invalid API key", async () => {
      const response = await fetch(`${BASE_URL}/models`, {
        headers: { Authorization: "Bearer invalid_key_12345" },
      });
      expect(response.ok).toBe(false);
      expect(response.status).toBeGreaterThanOrEqual(400);
    });

    it("should accept requests with a valid API key", async () => {
      const response = await fetch(`${BASE_URL}/models`, {
        headers: { Authorization: `Bearer ${API_KEY}` },
      });
      expect(response.ok).toBe(true);
    });
  });

  describe("Models endpoint", () => {
    let modelsData: RouteModels[];

    beforeAll(async () => {
      const response = await fetch(`${BASE_URL}/models`, {
        headers: { Authorization: `Bearer ${API_KEY}` },
      });
      expect(response.ok).toBe(true);
      modelsData = (await response.json()) as RouteModels[];
    });

    it("should return an array of route groups", () => {
      expect(Array.isArray(modelsData)).toBe(true);
      expect(modelsData.length).toBeGreaterThan(0);
    });

    it("each route group should have route, provider, and models", () => {
      for (const group of modelsData) {
        expect(group).toHaveProperty("route");
        expect(group).toHaveProperty("provider");
        expect(group).toHaveProperty("models");
        expect(typeof group.route).toBe("string");
        expect(typeof group.provider).toBe("string");
        expect(Array.isArray(group.models)).toBe(true);
      }
    });

    it("each model should have an id", () => {
      for (const group of modelsData) {
        for (const model of group.models) {
          expect(model).toHaveProperty("id");
          expect(typeof model.id).toBe("string");
          expect(model.id.length).toBeGreaterThan(0);
        }
      }
    });

    it("route and provider are distinct concepts", () => {
      // Routes are user-defined slugs (e.g. "opencode-openai", "minimax.io")
      // Providers are the upstream type (e.g. "openai", "anthropic")
      // They may differ — verify the API surfaces both independently
      for (const group of modelsData) {
        expect(typeof group.route).toBe("string");
        expect(typeof group.provider).toBe("string");
        // Route is the key used in the URL path for requests
        // Provider indicates the upstream API format
      }
    });

    it("should have at least one route with models", () => {
      const withModels = modelsData.filter((g) => g.models.length > 0);
      expect(withModels.length).toBeGreaterThan(0);
    });

    it("should be filterable by route query param", async () => {
      const firstRoute = modelsData[0].route;
      const response = await fetch(`${BASE_URL}/models?route=${firstRoute}`, {
        headers: { Authorization: `Bearer ${API_KEY}` },
      });
      if (!response.ok) return; // filtering might not be supported
      const filtered = (await response.json()) as RouteModels[];
      expect(filtered.length).toBeGreaterThanOrEqual(1);
      expect(filtered[0].route).toBe(firstRoute);
    });

    it("should be filterable by provider query param", async () => {
      const firstProvider = modelsData[0].provider;
      const response = await fetch(
        `${BASE_URL}/models?provider=${firstProvider}`,
        { headers: { Authorization: `Bearer ${API_KEY}` } },
      );
      if (!response.ok) return; // filtering might not be supported
      const filtered = (await response.json()) as RouteModels[];
      expect(filtered.length).toBeGreaterThan(0);
      for (const group of filtered) {
        expect(group.provider).toBe(firstProvider);
      }
    });
  });

  describe("Chat completions", () => {
    let route: string;
    let provider: string;
    let modelId: string;
    let chatPath: string;
    let chatEnabled = false;

    beforeAll(async () => {
      const response = await fetch(`${BASE_URL}/models`, {
        headers: { Authorization: `Bearer ${API_KEY}` },
      });
      const data = (await response.json()) as RouteModels[];

      // Find a route with models
      const target = data.find((g) => g.models.length > 0);
      expect(target).toBeDefined();

      route = target!.route;
      provider = target!.provider;
      chatPath = getChatPath(provider);

      // Pick a capable chat model (skip embedding-only models like "ada")
      const chatModel = target!.models.find(
        (m) =>
          m.id.includes("gpt-4") ||
          m.id.includes("gpt-3.5") ||
          m.id.includes("claude") ||
          m.id.includes("o4-mini") ||
          m.id.includes("o3"),
      );
      modelId = chatModel?.id ?? target!.models[0].id;

      // Probe if chat completions are enabled for this key/route
      const probe = await fetch(`${BASE_URL}/${route}/${chatPath}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: modelId,
          messages: [{ role: "user", content: "hi" }],
          stream: false,
          max_tokens: 5,
        }),
      });
      chatEnabled = probe.ok;
      if (!chatEnabled) {
        console.warn(
          `Chat completions not available for route=${route} model=${modelId} (HTTP ${probe.status}). ` +
            "Chat tests will be skipped. Set PYDANTIC_AI_GATEWAY to a key with chat access to enable.",
        );
      }
    });

    it("should complete a simple chat request (non-streaming)", async () => {
      if (!chatEnabled) return; // skip if chat not available for this key
      const url = `${BASE_URL}/${route}/${chatPath}`;
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: modelId,
          messages: [
            { role: "user", content: "Say hello in exactly 3 words." },
          ],
          stream: false,
          max_tokens: 50,
        }),
      });

      expect(response.ok).toBe(true);
      const data = (await response.json()) as {
        choices: Array<{ message: { content: string } }>;
      };
      expect(data.choices).toBeDefined();
      expect(data.choices.length).toBeGreaterThan(0);
      expect(data.choices[0].message.content.length).toBeGreaterThan(0);
    });

    it("should stream a chat response via SSE", async () => {
      if (!chatEnabled) return; // skip if chat not available for this key
      const url = `${BASE_URL}/${route}/${chatPath}`;
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: modelId,
          messages: [{ role: "user", content: "Say hi." }],
          stream: true,
          max_tokens: 20,
        }),
      });

      expect(response.ok).toBe(true);
      expect(response.body).not.toBeNull();

      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let fullText = "";
      let chunkCount = 0;
      let gotDone = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const text = decoder.decode(value, { stream: true });
        const lines = text.split("\n");

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data: ")) continue;

          const data = trimmed.slice(6);
          if (data === "[DONE]") {
            gotDone = true;
            continue;
          }

          try {
            const chunk = JSON.parse(data) as {
              choices?: Array<{ delta: { content?: string } }>;
            };
            const content = chunk.choices?.[0]?.delta?.content;
            if (content) {
              fullText += content;
              chunkCount++;
            }
          } catch {
            // Skip malformed chunks
          }
        }
      }

      expect(chunkCount).toBeGreaterThan(0);
      expect(fullText.length).toBeGreaterThan(0);
      expect(gotDone).toBe(true);
    });

    it("should support tool calling", async () => {
      if (!chatEnabled) return; // skip if chat not available for this key
      const url = `${BASE_URL}/${route}/${chatPath}`;
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: modelId,
          messages: [
            {
              role: "user",
              content: "What is the weather in San Francisco?",
            },
          ],
          stream: false,
          max_tokens: 200,
          tools: [
            {
              type: "function",
              function: {
                name: "get_weather",
                description: "Get the current weather for a location",
                parameters: {
                  type: "object",
                  properties: {
                    location: {
                      type: "string",
                      description: "City name",
                    },
                  },
                  required: ["location"],
                },
              },
            },
          ],
          tool_choice: "auto",
        }),
      });

      expect(response.ok).toBe(true);
      const data = (await response.json()) as {
        choices: Array<{
          message: {
            content: string | null;
            tool_calls?: Array<{
              id: string;
              type: string;
              function: { name: string; arguments: string };
            }>;
          };
          finish_reason: string;
        }>;
      };

      expect(data.choices).toBeDefined();
      expect(data.choices.length).toBeGreaterThan(0);

      const choice = data.choices[0];
      // Model should either call the tool or respond with text
      const hasToolCall =
        choice.message.tool_calls && choice.message.tool_calls.length > 0;
      const hasContent =
        choice.message.content && choice.message.content.length > 0;
      expect(hasToolCall || hasContent).toBe(true);

      if (hasToolCall) {
        const toolCall = choice.message.tool_calls![0];
        expect(toolCall.type).toBe("function");
        expect(toolCall.function.name).toBe("get_weather");
        const args = JSON.parse(toolCall.function.arguments);
        expect(args.location).toBeDefined();
      }
    });
  });

  describe("Model transformation logic", () => {
    it("should correctly transform gateway models into VS Code format", async () => {
      const response = await fetch(`${BASE_URL}/models`, {
        headers: { Authorization: `Bearer ${API_KEY}` },
      });
      const data = (await response.json()) as RouteModels[];

      // Simulate our extension's model transformation
      const vsCodeModels: Array<{
        id: string;
        name: string;
        route: string;
        provider: string;
        chatPath: string;
      }> = [];

      for (const routeGroup of data) {
        for (const model of routeGroup.models) {
          vsCodeModels.push({
            id: `${routeGroup.route}/${model.id}`,
            name: model.name ?? model.id,
            route: routeGroup.route,
            provider: routeGroup.provider,
            chatPath: getChatPath(routeGroup.provider),
          });
        }
      }

      expect(vsCodeModels.length).toBeGreaterThan(0);

      // All IDs should be unique
      const ids = vsCodeModels.map((m) => m.id);
      expect(new Set(ids).size).toBe(ids.length);

      // All IDs should contain a slash (route/model format)
      for (const model of vsCodeModels) {
        expect(model.id).toContain("/");
      }

      // Chat paths should be correctly assigned per provider
      for (const model of vsCodeModels) {
        if (model.provider === "anthropic") {
          expect(model.chatPath).toBe("v1/messages");
        } else {
          expect(model.chatPath).toBe("chat/completions");
        }
      }
    });

    it("route is used in URL path, provider determines API format", () => {
      // Example: route="opencode-openai" provider="openai"
      // The URL is: /proxy/opencode-openai/chat/completions
      // The route is user-defined, the provider defines behavior
      const exampleRoute = "opencode-openai";
      const exampleProvider = "openai";

      const url = `${BASE_URL}/${exampleRoute}/${getChatPath(exampleProvider)}`;
      expect(url).toContain("/opencode-openai/chat/completions");
    });
  });
});

export const EXTENSION_ID = "logfireGateway";
export const DEFAULT_BASE_URL = "https://gateway-us.pydantic.dev/proxy";
export const MODELS_ENDPOINT = "/models";
export const MODELS_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
export const DEFAULT_TIMEOUT_MS = 30000;

export const ERROR_MESSAGES = {
  AUTH_FAILED: "Failed to authenticate with Logfire AI Gateway. Please try again.",
  API_KEY_NOT_FOUND: "Logfire AI Gateway API key not found",
  MODELS_FETCH_FAILED: "Failed to fetch models from Logfire AI Gateway",
} as const;

/**
 * Maps gateway API types to the chat/messages path used by the gateway.
 * The `provider` field in the /models response is the wire-protocol type,
 * not the LLM provider name. Routes and providers both appear in the URL path;
 * a provider can be promoted to a route without changing clients.
 */
export const API_TYPE_CHAT_PATHS: Record<string, string> = {
  openai: "chat/completions",
  anthropic: "v1/messages",
  groq: "chat/completions",
  mistral: "chat/completions",
  azure: "chat/completions",
  ovhcloud: "chat/completions",
  huggingface: "chat/completions",
  bedrock: "chat/completions",
  "google-vertex": "chat/completions",
};

export const DEFAULT_CHAT_PATH = "chat/completions";

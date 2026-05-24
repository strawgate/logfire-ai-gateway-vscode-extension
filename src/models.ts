import type { LanguageModelChatInformation } from "vscode";
import { getConfig, type ModelOverride } from "./config";
import { MODELS_CACHE_TTL_MS, MODELS_ENDPOINT, API_TYPE_CHAT_PATHS, DEFAULT_CHAT_PATH } from "./constants";
import { logger } from "./logger";

/**
 * Model entry from the gateway /models API response.
 * `toolCalling` is set to true for models fetched from live provider endpoints
 * (they don't return capability metadata, but exposure via the API implies support).
 */
interface ModelEntry {
  id: string;
  name: string | undefined;
  context_window: number | undefined;
  toolCalling?: boolean; // explicit override; undefined = use pattern detection
}

/**
 * Route-grouped models from the gateway /models API.
 *
 * Terminology (from platform gateway codebase):
 * - `route`: The URL path slug identifying a configured provider endpoint
 *   (e.g., "minimax.io", "opencode-anthropic", "anthropic"). A user may have
 *   multiple routes using the same protocol. The route appears in the proxy URL:
 *   `/{route}/chat/completions` or `/{route}/v1/messages`.
 * - `protocol`: The wire-protocol handler type ("openai", "anthropic", "groq", etc.).
 *   This determines how the gateway formats/parses the request, NOT which company
 *   made the model. For example, minimax.io uses the "anthropic" protocol because
 *   MiniMax exposes an Anthropic-compatible API.
 *
 * Note: The gateway JSON response uses `provider` for this field; we rename it
 * to `protocol` at the parse boundary to avoid confusion with model vendors.
 */
interface RouteModels {
  route: string;
  protocol: string; // wire-protocol handler: "openai" | "anthropic" | etc.
  models: ModelEntry[];
}

interface ModelsCache {
  fetchedAt: number;
  models: LanguageModelChatInformation[];
}

/**
 * Extended model info that includes routing metadata.
 * Stored separately from VS Code's LanguageModelChatInformation.
 */
export interface ModelRouteInfo {
  route: string;
  apiType: string; // wire-protocol type: "openai" | "anthropic"
  chatPath: string;
}

/** Map from model ID (as exposed to VS Code) to routing info */
const modelRouteMap = new Map<string, ModelRouteInfo>();

export function getModelRouteInfo(modelId: string): ModelRouteInfo | undefined {
  return modelRouteMap.get(modelId);
}

const CAPABILITY_PATTERNS = {
  reasoning: /\b(o1|o3|o4|thinking|reason)/i,
  vision: /\b(vision|4o|gpt-4-turbo|claude-3|gemini)/i,
  toolCalling: /\b(gpt-4|gpt-3\.5-turbo|claude-3|gemini|mistral-large|command-r)/i,
};

export class ModelsClient {
  private modelsCache?: ModelsCache;
  private inflightFetch?: Promise<LanguageModelChatInformation[]>;

  invalidateCache(): void {
    this.modelsCache = undefined;
    modelRouteMap.clear();
  }

  async getModels(apiKey: string): Promise<LanguageModelChatInformation[]> {
    if (this.isModelsCacheFresh() && this.modelsCache) {
      return this.modelsCache.models;
    }

    if (this.inflightFetch) {
      return this.inflightFetch;
    }

    this.inflightFetch = this.fetchAndTransform(apiKey).finally(() => {
      this.inflightFetch = undefined;
    });

    return this.inflightFetch;
  }

  private async fetchAndTransform(
    apiKey: string,
  ): Promise<LanguageModelChatInformation[]> {
    const { endpoint } = getConfig();
    const startTime = Date.now();
    logger.info(`Fetching models from ${endpoint}${MODELS_ENDPOINT}`);

    // Step 1: get route list + apiTypes from the static endpoint
    const staticData = await this.fetchStaticModels(apiKey, `${endpoint}${MODELS_ENDPOINT}`);

    // Step 2: for each route, attempt to fetch live models from the provider.
    // - Anthropic routes: `GET /{route}/v1/models` (cursor-paginated)
    // - OpenAI routes:    `GET /{route}/models` (OpenAI list format)
    // Both return actual provider models rather than the genai-prices catalog.
    // When live models don't include context_window, we backfill from the static
    // seed data (which comes from genai-prices and does have context windows).
    const enrichedData = await Promise.all(
      staticData.map(async (routeGroup) => {
        const base = endpoint.replace(/\/+$/, "");
        // Build a quick lookup: static model id → context_window
        const staticContextWindow = new Map<string, number | undefined>(
          routeGroup.models.map((m) => [m.id, m.context_window]),
        );

        let liveModels: ModelEntry[] | null = null;
        if (routeGroup.protocol === "anthropic") {
          // Primary: Anthropic-native /v1/models endpoint
          liveModels = await this.fetchLiveAnthropicModels(
            apiKey,
            `${base}/${routeGroup.route}/v1/models`,
            routeGroup.route,
          );
          // Fallback: some anthropic-protocol routes (e.g. multi-vendor proxies)
          // don't expose /v1/models but do expose the OpenAI-format /models
          if (!liveModels) {
            liveModels = await this.fetchLiveOpenAIModels(
              apiKey,
              `${base}/${routeGroup.route}/models`,
              routeGroup.route,
            );
          }
        } else if (routeGroup.protocol === "openai") {
          liveModels = await this.fetchLiveOpenAIModels(
            apiKey,
            `${base}/${routeGroup.route}/models`,
            routeGroup.route,
          );
        }

        if (!liveModels) return routeGroup;

        // Backfill context_window from static data where the live endpoint
        // didn't provide it (live endpoints return minimal model metadata).
        const backfilled = liveModels.map((m) => ({
          ...m,
          context_window: m.context_window ?? staticContextWindow.get(m.id),
        }));
        return { ...routeGroup, models: backfilled };
      }),
    );

    const models = this.transformToVSCodeModels(enrichedData);
    logger.info(
      `Models fetched in ${Date.now() - startTime}ms, count: ${models.length}`,
    );
    this.modelsCache = { fetchedAt: Date.now(), models };
    return models;
  }

  private async fetchStaticModels(apiKey: string, url: string): Promise<RouteModels[]> {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    // Gateway JSON uses `provider` for the wire-protocol field; rename to `protocol`
    const raw = (await response.json()) as { route: string; provider: string; models: ModelEntry[] }[];
    return raw.map((r) => ({ route: r.route, protocol: r.provider, models: r.models }));
  }

  /**
   * Fetch live models from an Anthropic-compatible `/v1/models` endpoint,
   * following cursor-based pagination until `has_more` is false.
   * Returns null on any failure so the caller can fall back to static data.
   */
  private async fetchLiveAnthropicModels(
    apiKey: string,
    url: string,
    route: string,
  ): Promise<ModelEntry[] | null> {
    type AnthropicModel = { id: string; display_name?: string; context_window?: number };
    type AnthropicModelsPage = {
      data: AnthropicModel[];
      last_id: string | null;
      has_more: boolean;
    };

    const allModels: ModelEntry[] = [];
    let afterId: string | null = null;
    const maxPages = 10; // safety cap

    try {
      for (let page = 0; page < maxPages; page++) {
        const pageUrl = afterId ? `${url}?after_id=${encodeURIComponent(afterId)}` : url;
        const response = await fetch(pageUrl, {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "anthropic-version": "2023-06-01",
          },
        });
        if (!response.ok) {
          if (page === 0) {
            logger.debug(`Live model fetch failed for ${route}: HTTP ${response.status}`);
            return null;
          }
          break; // partial results are still useful
        }

        const data = (await response.json()) as AnthropicModelsPage;
        logger.debug(
          `Live /v1/models page ${page + 1} for ${route}: ${data.data?.length} models, has_more=${data.has_more}`,
        );

        for (const m of data.data ?? []) {
          allModels.push({
            id: m.id,
            name: m.display_name ?? m.id,
            context_window: m.context_window,
            // Live endpoint doesn't include capability metadata.
            // Exposure via the Anthropic Messages API implies tool-calling support.
            toolCalling: true,
          });
        }

        if (!data.has_more || !data.last_id) break;
        afterId = data.last_id;
      }

      logger.info(`Live models for ${route}: ${allModels.length} total (e.g. ${allModels[0]?.id})`);
      return allModels.length > 0 ? allModels : null;
    } catch (err) {
      logger.debug(`Live model fetch error for ${route}: ${err}`);
      return allModels.length > 0 ? allModels : null; // return partial results if any
    }
  }

  /**
   * Fetch live models from an OpenAI-compatible `/models` endpoint.
   * Returns null on any failure so the caller can fall back to static data.
   */
  private async fetchLiveOpenAIModels(
    apiKey: string,
    url: string,
    route: string,
  ): Promise<ModelEntry[] | null> {
    type OpenAIModel = { id: string; object: string };
    type OpenAIModelsPage = { data: OpenAIModel[] };

    try {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!response.ok) {
        logger.debug(`Live OpenAI model fetch failed for ${route}: HTTP ${response.status}`);
        return null;
      }
      const data = (await response.json()) as OpenAIModelsPage;
      const models: ModelEntry[] = (data.data ?? []).map((m) => ({
        id: m.id,
        name: m.id,
        context_window: undefined,
        toolCalling: true,
      }));
      logger.info(`Live OpenAI models for ${route}: ${models.length} total (e.g. ${models[0]?.id})`);
      return models.length > 0 ? models : null;
    } catch (err) {
      logger.debug(`Live OpenAI model fetch error for ${route}: ${err}`);
      return null;
    }
  }

  private isModelsCacheFresh(): boolean {
    return Boolean(
      this.modelsCache &&
        Date.now() - this.modelsCache.fetchedAt < MODELS_CACHE_TTL_MS,
    );
  }

  private transformToVSCodeModels(
    data: RouteModels[],
  ): LanguageModelChatInformation[] {
    const models: LanguageModelChatInformation[] = [];
    const { modelOverrides } = getConfig();

    for (const routeGroup of data) {
      const chatPath =
        API_TYPE_CHAT_PATHS[routeGroup.protocol] ?? DEFAULT_CHAT_PATH;

      for (const model of routeGroup.models) {
        // Use route/modelId as the VS Code model ID to avoid collisions
        const vsCodeModelId = `${routeGroup.route}/${model.id}`;
        const { family, version } = parseModelIdentity(model.id);
        const overrides: ModelOverride = modelOverrides[vsCodeModelId] ?? {};

        // Store routing info for later use during chat requests
        modelRouteMap.set(vsCodeModelId, {
          route: routeGroup.route,
          apiType: routeGroup.protocol,
          chatPath,
        });

        const contextWindow = overrides.contextWindow ?? model.context_window ?? 128000;

        models.push({
          id: vsCodeModelId,
          name: `[${routeGroup.route}] ${model.name ?? model.id}`,
          detail: `Logfire Gateway`,
          family,
          version,
          maxInputTokens: contextWindow,
          maxOutputTokens: overrides.maxOutputTokens ?? Math.min(contextWindow / 2, 16384),
          capabilities: {
            imageInput: overrides.vision ?? CAPABILITY_PATTERNS.vision.test(model.id),
            toolCalling: overrides.toolCalling ?? model.toolCalling ?? CAPABILITY_PATTERNS.toolCalling.test(model.id),
          },
        });
      }
    }

    return models;
  }
}

/**
 * Version pattern regex for date versions and semantic versions.
 */
const VERSION_PATTERN = /[-_](\d{4}-\d{2}-\d{2}|\d{4,8}|\d+\.\d+\.\d+)$/;

function parseModelIdentity(modelId: string): {
  family: string;
  version: string;
} {
  const match = modelId.match(VERSION_PATTERN);

  if (match) {
    const version = match[1];
    const family = modelId.slice(0, match.index);
    return { family, version };
  }

  return { family: modelId, version: "latest" };
}

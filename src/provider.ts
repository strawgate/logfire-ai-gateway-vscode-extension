import * as vscode from "vscode";
import {
  authentication,
  type CancellationToken,
  type LanguageModelChatInformation,
  type LanguageModelChatMessage,
  LanguageModelChatMessageRole,
  type LanguageModelChatProvider,
  LanguageModelChatToolMode,
  LanguageModelDataPart,
  type LanguageModelResponsePart,
  LanguageModelTextPart,
  LanguageModelToolCallPart,
  LanguageModelToolResultPart,
  type Progress,
  type ProvideLanguageModelChatResponseOptions,
  window,
} from "vscode";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";

import { LOGFIRE_AUTH_PROVIDER_ID, type LogfireAuthenticationProvider } from "./auth";
import { getConfig } from "./config";
import { ERROR_MESSAGES } from "./constants";
import { extractErrorMessage, logger } from "./logger";
import { getModelRouteInfo, ModelsClient } from "./models";

export class LogfireGatewayChatModelProvider
  implements LanguageModelChatProvider, vscode.Disposable
{
  private modelsClient = new ModelsClient();
  private readonly modelInfoChangeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation =
    this.modelInfoChangeEmitter.event;
  private readonly sessionChangeSubscription: vscode.Disposable;

  constructor(private readonly authProvider: LogfireAuthenticationProvider) {
    this.sessionChangeSubscription = authentication.onDidChangeSessions(
      (event) => {
        if (event.provider.id !== LOGFIRE_AUTH_PROVIDER_ID) return;
        this.modelsClient.invalidateCache();
        this.modelInfoChangeEmitter.fire();
      },
    );
  }

  dispose(): void {
    this.sessionChangeSubscription.dispose();
    this.modelInfoChangeEmitter.dispose();
  }

  /**
   * Fire the change event so VS Code calls provideLanguageModelChatInformation.
   * Must be called after registerLanguageModelChatProvider to trigger initial
   * model discovery — VS Code won't poll proactively without this signal.
   */
  signalModelsReady(): void {
    logger.debug("signalModelsReady: firing onDidChangeLanguageModelChatInformation");
    this.modelInfoChangeEmitter.fire();
  }

  async provideLanguageModelChatInformation(
    options: { silent: boolean },
    _token: CancellationToken,
  ): Promise<LanguageModelChatInformation[]> {
    logger.info(
      `provideLanguageModelChatInformation called (silent=${options.silent})`,
    );

    const apiKey = await this.getApiKey(options.silent);
    if (!apiKey) {
      logger.warn(
        `No API key available (silent=${options.silent}). Returning empty models list.`,
      );
      return [];
    }

    logger.info(`API key obtained (length=${apiKey.length}), fetching models...`);

    try {
      const models = await this.modelsClient.getModels(apiKey);
      logger.info(
        `Loaded ${models.length} models from Logfire AI Gateway` +
          (models.length > 0
            ? `. First 3: ${models.slice(0, 3).map((m) => m.id).join(", ")}`
            : ""),
      );
      return models;
    } catch (error) {
      logger.error(ERROR_MESSAGES.MODELS_FETCH_FAILED, error);
      return [];
    }
  }

  async provideLanguageModelChatResponse(
    model: LanguageModelChatInformation,
    chatMessages: readonly LanguageModelChatMessage[],
    options: ProvideLanguageModelChatResponseOptions,
    progress: Progress<LanguageModelResponsePart>,
    token: CancellationToken,
  ): Promise<void> {
    logger.info(
      `Chat request to ${model.id} with ${chatMessages.length} messages`,
    );

    const abortController = new AbortController();
    const abortSubscription = token.onCancellationRequested(() =>
      abortController.abort(),
    );

    try {
      const apiKey = await this.getApiKey(false);
      if (!apiKey) throw new Error(ERROR_MESSAGES.API_KEY_NOT_FOUND);

      const routeInfo = getModelRouteInfo(model.id);
      if (!routeInfo) throw new Error(`Unknown model route for ${model.id}`);

      const { endpoint } = getConfig();
      const baseURL = `${endpoint.replace(/\/+$/, "")}/${routeInfo.route}`;
      const actualModelId = model.id.replace(`${routeInfo.route}/`, "");

      if (routeInfo.apiType === "anthropic") {
        await this.streamAnthropic(
          baseURL,
          apiKey,
          actualModelId,
          chatMessages,
          options,
          progress,
          abortController,
        );
      } else {
        await this.streamOpenAI(
          baseURL,
          apiKey,
          actualModelId,
          chatMessages,
          options,
          progress,
          abortController,
        );
      }

      logger.info(`Chat request completed for ${model.id}`);
    } catch (error) {
      if (this.isAbortError(error)) {
        logger.debug("Request was cancelled");
        return;
      }
      logger.error("Exception during streaming:", error);
      progress.report(
        new LanguageModelTextPart(
          `\n\n**Error:** ${extractErrorMessage(error)}\n\n`,
        ),
      );
    } finally {
      abortSubscription.dispose();
    }
  }

  // ---- OpenAI streaming ----

  private async streamOpenAI(
    baseURL: string,
    apiKey: string,
    modelId: string,
    chatMessages: readonly LanguageModelChatMessage[],
    options: ProvideLanguageModelChatResponseOptions,
    progress: Progress<LanguageModelResponsePart>,
    abortController: AbortController,
  ): Promise<void> {
    const client = new OpenAI({
      baseURL,
      apiKey,
      fetch: globalThis.fetch,
    });

    const messages = convertToOpenAIMessages(chatMessages);
    const tools = buildOpenAITools(options.tools);

    const params: OpenAI.ChatCompletionCreateParamsStreaming = {
      model: modelId,
      messages,
      stream: true,
      temperature: options.modelOptions?.temperature ?? 0.7,
      max_tokens: options.modelOptions?.maxOutputTokens ?? 4096,
    };

    if (tools.length > 0) {
      params.tools = tools;
      params.tool_choice =
        options.toolMode === LanguageModelChatToolMode.Required
          ? "required"
          : "auto";
    }

    const stream = await client.chat.completions.create(params, {
      signal: abortController.signal,
    });

    const pendingToolCalls = new Map<
      number,
      { id: string; name: string; arguments: string }
    >();
    let responseSent = false;

    for await (const chunk of stream) {
      const choice = chunk.choices[0];
      if (!choice) continue;
      const delta = choice.delta;

      if (delta.content) {
        progress.report(new LanguageModelTextPart(delta.content));
        responseSent = true;
      }

      // Handle reasoning (OpenAI o-series models)
      const reasoning = (delta as Record<string, unknown>)
        .reasoning_content as string | undefined;
      if (reasoning) {
        this.handleReasoningChunk(reasoning, progress);
        responseSent = true;
      }

      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const existing = pendingToolCalls.get(tc.index);
          if (existing) {
            if (tc.function?.arguments)
              existing.arguments += tc.function.arguments;
          } else {
            pendingToolCalls.set(tc.index, {
              id: tc.id ?? `call_${tc.index}`,
              name: tc.function?.name ?? "",
              arguments: tc.function?.arguments ?? "",
            });
          }
        }
      }

      if (
        choice.finish_reason === "tool_calls" ||
        choice.finish_reason === "stop"
      ) {
        for (const [, tc] of pendingToolCalls) {
          if (tc.name) {
            let input: object;
            try {
              input = JSON.parse(tc.arguments || "{}") as object;
            } catch {
              input = {};
            }
            progress.report(
              new LanguageModelToolCallPart(tc.id, tc.name, input),
            );
            responseSent = true;
          }
        }
        pendingToolCalls.clear();
      }
    }

    if (!responseSent) {
      progress.report(
        new LanguageModelTextPart(
          "**Error**: No response received from model.",
        ),
      );
    }
  }

  // ---- Anthropic streaming ----

  private async streamAnthropic(
    baseURL: string,
    apiKey: string,
    modelId: string,
    chatMessages: readonly LanguageModelChatMessage[],
    options: ProvideLanguageModelChatResponseOptions,
    progress: Progress<LanguageModelResponsePart>,
    abortController: AbortController,
  ): Promise<void> {
    const client = new Anthropic({
      baseURL,
      apiKey,
    });

    const { system, messages } = convertToAnthropicMessages(chatMessages);
    const tools = buildAnthropicTools(options.tools);

    const params: Anthropic.MessageCreateParamsStreaming = {
      model: modelId,
      messages,
      max_tokens: options.modelOptions?.maxOutputTokens ?? 4096,
      stream: true,
    };

    if (system) params.system = system;
    if (options.modelOptions?.temperature != null) {
      params.temperature = options.modelOptions.temperature;
    }
    if (tools.length > 0) {
      params.tools = tools;
      if (options.toolMode === LanguageModelChatToolMode.Required) {
        params.tool_choice = { type: "any" };
      } else {
        params.tool_choice = { type: "auto" };
      }
    }

    const stream = client.messages.stream(params, {
      signal: abortController.signal,
    });

    let responseSent = false;
    const toolInputBuffers = new Map<number, { id: string; name: string; json: string }>();

    for await (const event of stream) {
      switch (event.type) {
        case "content_block_start": {
          const block = event.content_block;
          if (block.type === "tool_use") {
            toolInputBuffers.set(event.index, {
              id: block.id,
              name: block.name,
              json: "",
            });
          }
          break;
        }
        case "content_block_delta": {
          const delta = event.delta;
          if (delta.type === "text_delta") {
            progress.report(new LanguageModelTextPart(delta.text));
            responseSent = true;
          } else if (delta.type === "thinking_delta") {
            this.handleReasoningChunk(
              (delta as { thinking: string }).thinking,
              progress,
            );
            responseSent = true;
          } else if (delta.type === "input_json_delta") {
            const buf = toolInputBuffers.get(event.index);
            if (buf) buf.json += delta.partial_json;
          }
          break;
        }
        case "content_block_stop": {
          const buf = toolInputBuffers.get(event.index);
          if (buf) {
            let input: object;
            try {
              input = JSON.parse(buf.json || "{}") as object;
            } catch {
              input = {};
            }
            progress.report(
              new LanguageModelToolCallPart(buf.id, buf.name, input),
            );
            toolInputBuffers.delete(event.index);
            responseSent = true;
          }
          break;
        }
      }
    }

    if (!responseSent) {
      progress.report(
        new LanguageModelTextPart(
          "**Error**: No response received from model.",
        ),
      );
    }
  }

  // ---- Shared helpers ----

  async provideTokenCount(
    _model: LanguageModelChatInformation,
    text: string | LanguageModelChatMessage,
    _token: CancellationToken,
  ): Promise<number> {
    if (typeof text === "string") return Math.ceil(text.length / 4);
    let total = 0;
    for (const part of text.content) {
      if (part instanceof LanguageModelTextPart) {
        total += Math.ceil(part.value.length / 4);
      }
    }
    return total;
  }

  private isAbortError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    return (
      error.name === "AbortError" ||
      error.message.includes("aborted") ||
      error.message.includes("cancelled") ||
      error.message.includes("canceled")
    );
  }

  private async getApiKey(silent: boolean): Promise<string | undefined> {
    // For silent lookups (model discovery), read directly from our own secrets
    // storage. authentication.getSession with silent:true returns undefined until
    // the user explicitly grants consent via VS Code's accounts UI — even when
    // the session already exists in our provider.
    if (silent) {
      const token = await this.authProvider.getActiveToken();
      logger.debug(
        `getApiKey (silent): ${token ? `found token (length=${token.length})` : "no token stored"}`,
      );
      return token;
    }

    // For non-silent (chat requests with no prior auth), use VS Code's flow
    // which will prompt the user to authenticate if needed.
    try {
      logger.debug("getApiKey (interactive): requesting session via VS Code auth");
      const session = await authentication.getSession(
        LOGFIRE_AUTH_PROVIDER_ID,
        [],
        { createIfNone: true },
      );
      if (session) {
        logger.debug(
          `getApiKey (interactive): got session id=${session.id} account=${session.account.label}`,
        );
      } else {
        logger.debug("getApiKey (interactive): no session returned");
      }
      return session?.accessToken;
    } catch (error) {
      logger.error("Failed to get authentication session:", error);
      window.showErrorMessage(ERROR_MESSAGES.AUTH_FAILED);
      return undefined;
    }
  }

  private handleReasoningChunk(
    text: string,
    progress: Progress<LanguageModelResponsePart>,
  ): void {
    const vsAny = vscode as Record<string, unknown>;
    const ThinkingCtor = vsAny.LanguageModelThinkingPart as
      | (new (text: string) => LanguageModelResponsePart)
      | undefined;
    if (ThinkingCtor && text) {
      progress.report(new ThinkingCtor(text));
    }
  }
}

// ---- Message conversion: VS Code → OpenAI format ----

function convertToOpenAIMessages(
  messages: readonly LanguageModelChatMessage[],
): OpenAI.ChatCompletionMessageParam[] {
  const toolNameMap: Record<string, string> = {};
  for (const msg of messages) {
    for (const part of msg.content) {
      if (part instanceof LanguageModelToolCallPart) {
        toolNameMap[part.callId] = part.name;
      }
    }
  }

  const result: OpenAI.ChatCompletionMessageParam[] = [];

  for (const msg of messages) {
    const role =
      msg.role === LanguageModelChatMessageRole.User ? "user" : "assistant";

    for (const part of msg.content) {
      if (isTextPart(part)) {
        // Leading assistant messages become system messages
        if (role === "assistant" && result.length === 0) {
          result.push({ role: "system", content: part.value });
        } else {
          result.push({ role, content: part.value });
        }
      } else if (part instanceof LanguageModelDataPart) {
        if (part.mimeType.startsWith("image/")) {
          const base64 = Buffer.from(part.data).toString("base64");
          result.push({
            role: "user",
            content: [
              {
                type: "image_url",
                image_url: {
                  url: `data:${part.mimeType};base64,${base64}`,
                },
              },
            ],
          });
        }
      } else if (part instanceof LanguageModelToolCallPart) {
        result.push({
          role: "assistant",
          tool_calls: [
            {
              id: part.callId,
              type: "function",
              function: {
                name: part.name,
                arguments: JSON.stringify(part.input ?? {}),
              },
            },
          ],
        });
      } else if (part instanceof LanguageModelToolResultPart) {
        const texts = part.content
          .filter(
            (p): p is { value: string } =>
              typeof p === "object" && p !== null && "value" in p,
          )
          .map((p) => p.value);
        result.push({
          role: "tool",
          content: texts.join(" "),
          tool_call_id: part.callId,
        });
      }
    }
  }

  return result.filter((msg) => {
    if ("content" in msg && typeof msg.content === "string") {
      return msg.content.trim().length > 0 || ("tool_calls" in msg);
    }
    return true;
  });
}

function buildOpenAITools(
  tools?: readonly { name: string; description?: string; inputSchema?: unknown }[],
): OpenAI.ChatCompletionTool[] {
  if (!tools || tools.length === 0) return [];
  return tools.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description ?? "",
      parameters: (tool.inputSchema as Record<string, unknown>) ?? {
        type: "object",
        properties: {},
      },
    },
  }));
}

// ---- Message conversion: VS Code → Anthropic format ----

function convertToAnthropicMessages(messages: readonly LanguageModelChatMessage[]): {
  system: string | undefined;
  messages: Anthropic.MessageParam[];
} {
  let system: string | undefined;
  const result: Anthropic.MessageParam[] = [];

  const toolNameMap: Record<string, string> = {};
  for (const msg of messages) {
    for (const part of msg.content) {
      if (part instanceof LanguageModelToolCallPart) {
        toolNameMap[part.callId] = part.name;
      }
    }
  }

  for (const msg of messages) {
    const role =
      msg.role === LanguageModelChatMessageRole.User ? "user" : "assistant";

    // Leading assistant messages become system prompt
    if (role === "assistant" && result.length === 0) {
      const textParts = msg.content.filter(isTextPart);
      if (textParts.length > 0) {
        system = textParts.map((p) => p.value).join("\n");
        continue;
      }
    }

    const contentBlocks: Anthropic.ContentBlockParam[] = [];

    for (const part of msg.content) {
      if (isTextPart(part)) {
        contentBlocks.push({ type: "text", text: part.value });
      } else if (part instanceof LanguageModelDataPart) {
        if (part.mimeType.startsWith("image/")) {
          const base64 = Buffer.from(part.data).toString("base64");
          contentBlocks.push({
            type: "image",
            source: {
              type: "base64",
              media_type: part.mimeType as
                | "image/jpeg"
                | "image/png"
                | "image/gif"
                | "image/webp",
              data: base64,
            },
          });
        }
      } else if (part instanceof LanguageModelToolCallPart) {
        contentBlocks.push({
          type: "tool_use",
          id: part.callId,
          name: part.name,
          input: (part.input as Record<string, unknown>) ?? {},
        });
      } else if (part instanceof LanguageModelToolResultPart) {
        const texts = part.content
          .filter(
            (p): p is { value: string } =>
              typeof p === "object" && p !== null && "value" in p,
          )
          .map((p) => p.value);
        contentBlocks.push({
          type: "tool_result",
          tool_use_id: part.callId,
          content: texts.join(" "),
        });
      }
    }

    if (contentBlocks.length > 0) {
      // Anthropic requires alternating user/assistant. Merge consecutive same-role.
      const last = result[result.length - 1];
      if (last && last.role === role) {
        const existing = Array.isArray(last.content)
          ? last.content
          : [{ type: "text" as const, text: last.content }];
        (last as { content: Anthropic.ContentBlockParam[] }).content = [
          ...existing,
          ...contentBlocks,
        ];
      } else {
        result.push({ role, content: contentBlocks });
      }
    }
  }

  return { system, messages: result };
}

function buildAnthropicTools(
  tools?: readonly { name: string; description?: string; inputSchema?: unknown }[],
): Anthropic.Tool[] {
  if (!tools || tools.length === 0) return [];
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description ?? "",
    input_schema: (tool.inputSchema as Anthropic.Tool.InputSchema) ?? {
      type: "object" as const,
      properties: {},
    },
  }));
}

// ---- Shared utilities ----

function isTextPart(part: unknown): part is { value: string } {
  return (
    typeof part === "object" &&
    part !== null &&
    "value" in part &&
    typeof (part as { value: unknown }).value === "string"
  );
}

# Logfire AI Gateway — VS Code Extension

Connects VS Code's Language Model API to a [Pydantic AI / Logfire Gateway](https://logfire.pydantic.dev), making every model your gateway exposes available in VS Code Chat, Copilot Edits, and any extension that uses the Language Model API.

## Prerequisites

You need a **Pydantic AI Gateway API key** (starts with `pylf_v2_...`). Keys are created at [logfire.pydantic.dev](https://logfire.pydantic.dev).

## Installation

1. Install this extension from the VS Code Marketplace (search **Logfire AI Gateway**).
2. Open the Command Palette (`Cmd/Ctrl+Shift+P`) → **Logfire AI Gateway: Manage Authentication**.
3. Paste your API key. Models will appear in the model picker immediately.

## Models

Models are fetched live from your gateway on startup (and refreshed every 5 minutes). Each model is named `[route] display-name` in the picker, with an internal ID of `route/model-id`.

For example, if your gateway has a route `opencode-openai` exposing DeepSeek, GLM, MiniMax, and Kimi models, they appear as:

```
[opencode-openai] deepseek-v4-pro
[opencode-openai] glm-5.1
[opencode-openai] minimax-m2.7
[opencode-openai] kimi-k2.6
```

Tool calling and streaming are supported for all models.

## Configuration

| Setting | Default | Description |
|---|---|---|
| `logfireGateway.endpoint` | `https://gateway-us.pydantic.dev/proxy` | Gateway base URL |
| `logfireGateway.timeout` | `30000` | Request timeout in ms (5 000 – 300 000) |

### Regional endpoints

| Region | URL |
|---|---|
| US (default) | `https://gateway-us.pydantic.dev/proxy` |
| EU | `https://gateway-eu.pydantic.dev/proxy` |

Change the endpoint via **Settings** → search `logfireGateway.endpoint`, or add to your `settings.json`:

```json
{
  "logfireGateway.endpoint": "https://gateway-eu.pydantic.dev/proxy"
}
```

## How it works

The gateway organises models into **routes** (named groups) that map to one or more upstream providers. The extension:

1. Calls `GET /models` on the gateway to get the route list.
2. For each route, fetches live models from `/{route}/models` (OpenAI-compatible routes) or `/{route}/v1/models` (Anthropic-compatible routes).
3. Registers all discovered models as VS Code Language Model Chat Providers.
4. Routes chat requests to the correct upstream endpoint using the OpenAI or Anthropic SDK depending on the route's API type.

## License

MIT

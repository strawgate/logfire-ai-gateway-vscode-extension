# Developing the Logfire AI Gateway Extension

## Prerequisites

- Node.js 20+
- VS Code 1.108+
- A Pydantic AI Gateway API key for E2E tests (optional but recommended)

## Setup

```bash
git clone https://github.com/strawgate/logfire-ai-gateway-vscode-extension
cd logfire-ai-gateway-vscode-extension
npm install
```

Optional — create `.env` for E2E tests:

```
PYDANTIC_AI_GATEWAY=pylf_v2_us_...
```

## Project structure

```
src/
  extension.ts     Entry point: wires auth provider, model provider, commands
  auth.ts          VS Code AuthenticationProvider — stores the API key in secrets
  provider.ts      LanguageModelChatProvider — streams chat responses
  models.ts        Fetches and caches gateway models; maps them to VS Code format
  config.ts        Reads logfireGateway.* VS Code settings
  constants.ts     Shared constants (endpoint paths, cache TTL, extension ID)
  logger.ts        LogOutputChannel wrapper

test/
  unit.test.ts           Vitest unit tests (25 tests, no network, no VS Code)
  gateway.e2e.test.ts    Vitest E2E tests against the real gateway (15 tests)
  vscode-e2e/
    extension.test.ts    VS Code extension host tests (15 tests, Mocha TDD)
    tsconfig.json        Compiles to out/test-vscode/
```

## Build

```bash
npm run build      # esbuild bundle → out/extension.js
npm run dev        # watch mode
npm run tsc        # type-check only (no emit)
```

## Testing

```bash
# Unit + gateway E2E (vitest, no VS Code process)
npm test

# Unit tests only
npm run test:unit

# Gateway E2E only (requires PYDANTIC_AI_GATEWAY env var or .env)
npm run test:e2e

# VS Code extension host tests (requires PYDANTIC_AI_GATEWAY for model discovery)
PYDANTIC_AI_GATEWAY=pylf_v2_... npm run test:vscode
```

The VS Code E2E tests inject the API key directly into extension secrets at test startup — no manual auth flow needed.

## Running in VS Code

Press **F5** (or use the **Run Extension** launch configuration) to open a new Extension Development Host window with the extension loaded.

## Architecture notes

### Model fetching

On activation, `ModelsClient.getModels()` performs a two-phase fetch:

1. `GET /models` — static route list with `route`, `provider` (= `openai` | `anthropic`), and a model seed list from the genai-prices catalog.
2. For each route:
   - **OpenAI routes**: `GET /{route}/models` — live model list from the upstream provider.
   - **Anthropic routes**: `GET /{route}/v1/models` — live model list with cursor pagination (`?after_id=`).

Live results replace the static seed. If a live fetch fails, the static list is used as a fallback.

Results are cached for 5 minutes. `signalModelsReady()` fires `onDidChangeLanguageModelChatInformation` after the first successful fetch.

### Chat routing

`provider.ts` looks up the model's `ModelRouteInfo` (stored in a module-level `Map` by `models.ts`) to find the `route`, `apiType`, and `chatPath`. It then delegates to either `streamOpenAI()` or `streamAnthropic()`.

| apiType    | SDK                    | endpoint path          |
|------------|------------------------|------------------------|
| `openai`   | `openai` npm package   | `/{route}/chat/completions` |
| `anthropic`| `@anthropic-ai/sdk`    | `/{route}/v1/messages` |

### Authentication

The extension registers a VS Code `AuthenticationProvider`. Because VS Code's `getSession({silent:true})` shows a consent UI, the provider exposes `getActiveToken()` which reads directly from `SecretStorage` — bypassing the consent model for background use (model fetching, chat).

## Packaging

```bash
npm run package    # produces .vsix
```

Requires `@vscode/vsce` (included as devDependency). The `prepackage` script runs `npm run build` automatically.

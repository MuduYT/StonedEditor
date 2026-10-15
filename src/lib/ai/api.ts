import type {
  editor as MonacoEditor,
  IPosition,
  IRange,
} from "monaco-editor";

/* ------------------------------------------------------------------ *
 *  OpenRouter transport layer
 *  ------------------------------------------------------------------
 *  Docs: https://openrouter.ai/docs
 *  - POST /chat/completions      (OpenAI-compatible, SSE streaming)
 *  - GET  /models                (public, no key required)
 *  - GET  /key                   (validates the key, returns credits)
 * ------------------------------------------------------------------ */

export const OPENROUTER_BASE_URL =
  process.env.NEXT_PUBLIC_OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1";

/** Selectable base URLs in the settings dialog (custom URLs stay possible). */
export const OPENROUTER_BASE_URLS = ["https://openrouter.ai/api/v1"] as const;

export const OPENROUTER_KEYS_URL = "https://openrouter.ai/keys";
export const OPENROUTER_FREE_MODELS_URL = "https://openrouter.ai/models?max_price=0";

/**
 * Last-resort default when no model was stored yet. Kept on a plain chat model:
 * the `openrouter/free` router can also route to classifier or music models.
 */
export const DEFAULT_OPENROUTER_MODEL =
  process.env.NEXT_PUBLIC_OPENROUTER_MODEL ?? "cohere/north-mini-code:free";

export const OPENROUTER_APP_TITLE = "StonedEditor";

/** Free models are heavily rate limited, so be patient before giving up. */
const DEFAULT_CONNECT_TIMEOUT_MS = 90_000;
const DEFAULT_IDLE_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 900;

/* ------------------------------------------------------------------ *
 *  Types
 * ------------------------------------------------------------------ */

export type ChatRole = "system" | "developer" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: ChatRole;
  content: string;
  name?: string;
  tool_call_id?: string;
}

export interface TokenUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  cost?: number;
  /** Present when `usage: { include: true }` was requested. */
  cost_details?: Record<string, unknown>;
}

export type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface RetryInfo {
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  reason: string;
}

export interface StreamChatOptions {
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  baseUrl?: string;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  extraBody?: Record<string, unknown>;
  fetchImpl?: FetchLike;
  /** Called for every content delta. */
  onTextDelta?: (delta: string, fullText: string) => void;
  /** Called for reasoning/thinking deltas (reasoning models). */
  onReasoningDelta?: (delta: string, fullReasoning: string) => void;
  onRawEvent?: (event: unknown) => void;
  /** Automatic retries when the request fails before any token arrived. */
  maxRetries?: number;
  onRetry?: (info: RetryInfo) => void;
  connectTimeoutMs?: number;
  idleTimeoutMs?: number;
  /** Attribution headers (optional, recommended by OpenRouter). */
  appTitle?: string;
  appUrl?: string;
}

export interface StreamChatResult {
  text: string;
  reasoning: string;
  finishReason: string | null;
  responseId?: string;
  responseModel?: string;
  usage?: TokenUsage;
  attempts: number;
  aborted: boolean;
}

export interface FileContext {
  path?: string;
  language?: string;
  content: string;
  selection?: string;
}

export interface StreamIntoMonacoOptions extends StreamChatOptions {
  editor: MonacoEditor.IStandaloneCodeEditor;
  range?: IRange;
  keepCursorAtEnd?: boolean;
}

interface OpenRouterErrorMetadata {
  provider_name?: string;
  limit_source?: string;
  raw?: string;
  remedy_hint?: string;
  provider_error_code?: string;
}

interface OpenRouterErrorPayload {
  message?: string;
  code?: string | number;
  metadata?: OpenRouterErrorMetadata;
}

/** Free endpoints share one upstream pool – this is by far the most common failure. */
function isUpstreamPoolLimit(metadata?: OpenRouterErrorMetadata) {
  return metadata?.limit_source === "upstream_provider_shared_pool";
}

interface OpenAICompatibleChunk {
  id?: string;
  model?: string;
  error?: OpenRouterErrorPayload;
  choices?: Array<{
    text?: string;
    finish_reason?: string | null;
    delta?: {
      content?: unknown;
      reasoning?: unknown;
      reasoning_content?: unknown;
      refusal?: unknown;
    };
    message?: { content?: unknown };
  }>;
  usage?: TokenUsage;
}

/* ------------------------------------------------------------------ *
 *  Errors
 * ------------------------------------------------------------------ */

export class OpenRouterApiError extends Error {
  readonly status?: number;
  readonly code?: string | number;
  readonly details?: unknown;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly aborted: boolean;
  readonly authError: boolean;
  readonly outOfCredits: boolean;
  readonly rateLimited: boolean;
  readonly modelNotFound: boolean;
  readonly providerName?: string;
  /** Free endpoints were rate limited upstream by the provider itself. */
  readonly upstreamLimited: boolean;
  /** True when switching to another model is the most likely fix. */
  readonly suggestOtherModel: boolean;

  constructor(
    message: string,
    options: {
      status?: number;
      code?: string | number;
      details?: unknown;
      retryable?: boolean;
      retryAfterMs?: number;
      aborted?: boolean;
      providerName?: string;
      upstreamLimited?: boolean;
      suggestOtherModel?: boolean;
    } = {},
  ) {
    super(message);
    this.name = "OpenRouterApiError";
    this.status = options.status;
    this.code = options.code;
    this.details = options.details;
    this.retryable = options.retryable ?? false;
    this.retryAfterMs = options.retryAfterMs;
    this.aborted = options.aborted ?? false;
    this.authError = options.status === 401 || options.status === 403;
    this.outOfCredits = options.status === 402;
    this.rateLimited = options.status === 429;
    this.modelNotFound =
      options.status === 404 || options.code === "model_not_found";
    this.providerName = options.providerName;
    this.upstreamLimited = options.upstreamLimited ?? false;
    this.suggestOtherModel =
      options.suggestOtherModel ??
      (options.status === 402 ||
        options.status === 429 ||
        options.status === 502 ||
        options.status === 503 ||
        options.status === 404);
  }
}

export function isUserAbort(error: unknown): boolean {
  if (error instanceof OpenRouterApiError) {
    return error.aborted;
  }

  if (error instanceof Error) {
    return error.name === "AbortError" || error.name === "TimeoutError";
  }

  return false;
}

export function describeError(error: unknown): string {
  if (error instanceof OpenRouterApiError) {
    return error.message;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

/* ------------------------------------------------------------------ *
 *  Helpers
 * ------------------------------------------------------------------ */

export function normalizeOpenRouterBaseUrl(baseUrl = OPENROUTER_BASE_URL) {
  let normalized = (baseUrl ?? "").trim();

  if (!normalized) {
    return OPENROUTER_BASE_URL;
  }

  if (!/^https?:\/\//i.test(normalized)) {
    normalized = `https://${normalized}`;
  }

  normalized = normalized.replace(/\/+$/, "");

  if (normalized.endsWith("/chat/completions")) {
    return normalized.slice(0, -"/chat/completions".length);
  }

  return normalized.endsWith("/v1") ? normalized : `${normalized}/v1`;
}

export function openRouterAppUrl(): string {
  if (typeof window !== "undefined" && window.location?.origin) {
    return window.location.origin;
  }

  return "https://stonededitor.local";
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }

    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function abortError(): OpenRouterApiError {
  return new OpenRouterApiError("Anfrage abgebrochen.", { aborted: true });
}

function idleError(details?: unknown): OpenRouterApiError {
  return new OpenRouterApiError(
    "Der Anbieter hat mitten in der Antwort nichts mehr gesendet. Bitte erneut versuchen oder ein anderes Modell wählen.",
    { retryable: true, suggestOtherModel: true, details },
  );
}

function readRetryAfterMs(response: Response): number | undefined {
  const raw =
    response.headers.get("retry-after") ?? response.headers.get("x-ratelimit-reset-requests");

  if (!raw) {
    return undefined;
  }

  const seconds = Number(raw);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }

  const date = Date.parse(raw);
  if (!Number.isNaN(date)) {
    return Math.max(0, date - Date.now());
  }

  return undefined;
}

async function parseErrorPayload(response: Response) {
  const rawBody = await response.text().catch(() => "");
  let payload: OpenRouterErrorPayload | undefined;
  let message = rawBody.slice(0, 500);

  if (rawBody) {
    try {
      const parsed = JSON.parse(rawBody) as {
        error?: OpenRouterErrorPayload;
        message?: string;
      };
      payload = parsed.error ?? undefined;
      message = payload?.message ?? parsed.message ?? message;
    } catch {
      // keep the raw body as message
    }
  }

  return { payload, message: message?.trim() || undefined };
}

export async function createResponseError(response: Response) {
  const { payload, message } = await parseErrorPayload(response);
  const serverMessage = message ? ` (${message})` : "";
  const status = response.status;

  const base = {
    status,
    code: payload?.code,
    details: payload ?? message,
    retryAfterMs: readRetryAfterMs(response),
  };

  const provider = payload?.metadata?.provider_name;
  const providerSuffix = provider ? ` (${provider})` : "";

  switch (status) {
    case 400:
      return new OpenRouterApiError(
        `Ungültige Anfrage an OpenRouter${serverMessage}`,
        base,
      );
    case 401:
    case 403:
      return new OpenRouterApiError(
        status === 401
          ? `API-Key ungültig oder abgelaufen. Prüfe deinen Key unter openrouter.ai/keys${serverMessage}`
          : `Zugriff verweigert – der Key darf dieses Modell nicht nutzen${serverMessage}`,
        base,
      );
    case 402:
      return new OpenRouterApiError(
        `Nicht genug Guthaben für dieses Modell. Nimm ein kostenloses Modell (Filter „Kostenlos“) oder lade Guthaben auf OpenRouter${serverMessage}`,
        base,
      );
    case 404:
      return new OpenRouterApiError(
        `Modell oder Endpoint nicht gefunden. Wähle im Modell-Menü ein anderes Modell${serverMessage}`,
        base,
      );
    case 408:
    case 524:
      return new OpenRouterApiError(
        `Der Anbieter hat nicht rechtzeitig geantwortet. Bitte erneut versuchen${serverMessage}`,
        { ...base, retryable: true },
      );
    case 429:
      return createRateLimitError(payload, base);
    case 502:
    case 503:
      return new OpenRouterApiError(
        `Der Modell-Anbieter${providerSuffix} ist gerade nicht erreichbar. Anderes Modell wählen oder erneut versuchen${serverMessage}`,
        { ...base, retryable: true, providerName: provider },
      );
    default:
      if (status >= 500) {
        return new OpenRouterApiError(
          `OpenRouter meldet einen Serverfehler (HTTP ${status})${serverMessage}`,
          { ...base, retryable: true },
        );
      }

      return new OpenRouterApiError(
        `OpenRouter antwortete mit HTTP ${status}${serverMessage}`,
        base,
      );
  }
}

/**
 * 429 has two very different causes: an OpenRouter account limit, or the shared
 * free pool of an upstream provider being busy. The user needs to know which one.
 */
function createRateLimitError(
  payload: OpenRouterErrorPayload | undefined,
  base: {
    status: number;
    code?: string | number;
    details?: unknown;
    retryAfterMs?: number;
  },
) {
  const provider = payload?.metadata?.provider_name;
  const providerSuffix = provider ? ` von ${provider}` : "";

  if (isUpstreamPoolLimit(payload?.metadata)) {
    return new OpenRouterApiError(
      `Der kostenlose Endpoint${providerSuffix} ist gerade ausgelastet (gemeinsamer Gratis-Pool). Warte kurz oder wähle ein anderes Modell.`,
      {
        ...base,
        retryable: true,
        providerName: provider,
        upstreamLimited: true,
      },
    );
  }

  return new OpenRouterApiError(
    `Rate-Limit erreicht${provider ? ` (${provider})` : ""}. Kostenlose Modelle sind stark limitiert – kurz warten oder ein anderes Modell wählen.`,
    { ...base, retryable: true, providerName: provider },
  );
}

/** Errors that arrive as an SSE `error` event in the middle of a stream. */
function createStreamError(
  payload: OpenRouterErrorPayload,
  status = 502,
) {
  const base = {
    status,
    code: payload.code,
    details: payload,
    providerName: payload.metadata?.provider_name,
    upstreamLimited: isUpstreamPoolLimit(payload.metadata),
  };

  if (isUpstreamPoolLimit(payload.metadata)) {
    return new OpenRouterApiError(
      `Der kostenlose Endpoint${payload.metadata?.provider_name ? ` von ${payload.metadata.provider_name}` : ""} ist gerade ausgelastet (gemeinsamer Gratis-Pool). Warte kurz oder wähle ein anderes Modell.`,
      { ...base, retryable: true },
    );
  }

  return new OpenRouterApiError(
    payload.message
      ? `Der Anbieter hat den Stream abgebrochen: ${payload.message}`
      : "Der Anbieter hat den Stream abgebrochen.",
    base,
  );
}

function isRetryableError(error: unknown, response?: Response) {
  if (response) {
    return response.status === 408 || response.status === 429 || response.status >= 500;
  }

  if (error instanceof OpenRouterApiError) {
    return error.retryable;
  }

  // Network-level failures (DNS, TLS, offline, CORS preflight aborts) are retryable.
  return error instanceof TypeError;
}

/* ------------------------------------------------------------------ *
 *  Low level fetch helpers
 * ------------------------------------------------------------------ */

async function fetchWithTimeout(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  controller: AbortController,
  timeoutMs: number,
) {
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (timedOut) {
      throw new OpenRouterApiError(
        "OpenRouter hat nicht rechtzeitig geantwortet – Verbindung prüfen und erneut versuchen.",
        { retryable: true },
      );
    }

    if (error instanceof Error && error.name === "AbortError") {
      throw abortError();
    }

    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** Simple JSON GET/POST used for the models catalogue and the key check. */
export async function fetchJson<T>(
  url: string,
  options: {
    apiKey?: string;
    method?: string;
    body?: unknown;
    signal?: AbortSignal;
    fetchImpl?: FetchLike;
    headers?: Record<string, string>;
    timeoutMs?: number;
  } = {},
): Promise<T> {
  const {
    apiKey,
    method = "GET",
    body,
    signal,
    fetchImpl = globalThis.fetch.bind(globalThis),
    headers = {},
    timeoutMs = 30_000,
  } = options;

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const response = await fetchWithTimeout(
      fetchImpl,
      url,
      {
        method,
        headers: {
          Accept: "application/json",
          ...(apiKey ? { Authorization: `Bearer ${apiKey.trim()}` } : {}),
          ...(body ? { "Content-Type": "application/json" } : {}),
          ...headers,
        },
        body: body ? JSON.stringify(body) : undefined,
      },
      controller,
      timeoutMs,
    );

    if (!response.ok) {
      throw await createResponseError(response);
    }

    return (await response.json()) as T;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

export interface OpenRouterKeyInfo {
  label?: string;
  usage?: number;
  limit?: number | null;
  limit_remaining?: number | null;
  is_free_tier?: boolean;
  rate_limit?: { requests?: number; interval?: string };
}

/** Verifies the API key and returns credit information. */
export async function fetchOpenRouterKeyInfo(options: {
  apiKey: string;
  baseUrl?: string;
  signal?: AbortSignal;
  fetchImpl?: FetchLike;
}): Promise<OpenRouterKeyInfo> {
  const { apiKey, baseUrl, signal, fetchImpl } = options;

  if (!apiKey?.trim()) {
    throw new OpenRouterApiError("Kein API-Key hinterlegt.");
  }

  const payload = await fetchJson<{ data?: OpenRouterKeyInfo } | OpenRouterKeyInfo>(
    `${normalizeOpenRouterBaseUrl(baseUrl)}/key`,
    { apiKey, signal, fetchImpl },
  );

  if (payload && typeof payload === "object" && "data" in payload) {
    return (payload as { data?: OpenRouterKeyInfo }).data ?? {};
  }

  return (payload as OpenRouterKeyInfo) ?? {};
}

/* ------------------------------------------------------------------ *
 *  Chat streaming
 * ------------------------------------------------------------------ */

export async function streamChatCompletion(
  options: StreamChatOptions,
): Promise<StreamChatResult> {
  const {
    apiKey,
    model,
    messages,
    baseUrl,
    temperature,
    maxTokens,
    signal,
    extraBody,
    fetchImpl = globalThis.fetch.bind(globalThis),
    onTextDelta,
    onReasoningDelta,
    onRawEvent,
    maxRetries = DEFAULT_MAX_RETRIES,
    onRetry,
    connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
    idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
    appTitle = OPENROUTER_APP_TITLE,
    appUrl,
  } = options;

  if (!apiKey?.trim()) {
    throw new OpenRouterApiError(
      "Kein OpenRouter API-Key hinterlegt. Öffne die Einstellungen und trage deinen Key ein.",
    );
  }

  if (!model?.trim() && !Array.isArray(extraBody?.models)) {
    throw new OpenRouterApiError("Es ist kein Modell ausgewählt.");
  }

  if (messages.length === 0) {
    throw new OpenRouterApiError("Mindestens eine Chat-Nachricht ist erforderlich.");
  }

  const endpoint = `${normalizeOpenRouterBaseUrl(baseUrl)}/chat/completions`;
  const fallbackModels = Array.isArray(extraBody?.models)
    ? (extraBody.models as string[]).filter(Boolean)
    : undefined;
  const body: Record<string, unknown> = {
    model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    usage: { include: true },
    ...extraBody,
  };

  // With a fallback chain OpenRouter expects `models` instead of a single `model`.
  // OpenRouter rejects chains longer than 3 entries, so never send more.
  if (fallbackModels && fallbackModels.length > 0) {
    body.models = [...new Set(fallbackModels)].slice(0, 3);
    delete body.model;
  }

  if (temperature !== undefined) {
    body.temperature = temperature;
  }

  if (maxTokens !== undefined) {
    body.max_tokens = maxTokens;
  }

  const requestInit: RequestInit = {
    method: "POST",
    headers: {
      Accept: "text/event-stream",
      Authorization: `Bearer ${apiKey.trim()}`,
      "Content-Type": "application/json",
      "HTTP-Referer": appUrl ?? openRouterAppUrl(),
      "X-Title": appTitle,
    },
    body: JSON.stringify(body),
  };

  /* --- request with retries (only before the first token) -------------- */
  let response: Response | undefined;
  let attempts = 0;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    attempts = attempt + 1;

    if (signal?.aborted) {
      throw abortError();
    }

    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      response = await fetchWithTimeout(
        fetchImpl,
        endpoint,
        requestInit,
        controller,
        connectTimeoutMs,
      );

      if (!response.ok) {
        throw await createResponseError(response);
      }

      signal?.removeEventListener("abort", onAbort);
      break;
    } catch (error) {
      signal?.removeEventListener("abort", onAbort);

      if (signal?.aborted || isUserAbort(error)) {
        throw error;
      }

      const retryable = isRetryableError(error, response);

      if (!retryable || attempt === maxRetries) {
        throw error;
      }

      // A busy upstream free pool needs a real pause, not a 1 second retry.
      const upstreamLimited =
        error instanceof OpenRouterApiError && error.upstreamLimited;
      const backoff = upstreamLimited
        ? 5_000 * 2 ** attempt + Math.random() * 750
        : RETRY_BASE_DELAY_MS * 3 ** attempt + Math.random() * 400;
      const delayMs =
        error instanceof OpenRouterApiError && error.retryAfterMs
          ? Math.min(30_000, Math.max(error.retryAfterMs, backoff))
          : Math.min(30_000, backoff);

      onRetry?.({
        attempt: attempt + 1,
        maxAttempts: maxRetries,
        delayMs,
        reason: describeError(error),
      });

      await sleep(delayMs, signal);
      response = undefined;
    }
  }

  if (!response) {
    throw new OpenRouterApiError(
      "Die Anfrage konnte nicht an OpenRouter gesendet werden. Internetverbindung prüfen.",
      { retryable: true },
    );
  }

  if (!response.body) {
    throw new OpenRouterApiError(
      "Die Antwort von OpenRouter enthält keinen lesbaren Datenstrom.",
      { status: response.status },
    );
  }

  /* --- consume the SSE stream ----------------------------------------- */
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let textBuffer = "";
  let eventData: string[] = [];
  let fullText = "";
  let fullReasoning = "";
  let finishReason: string | null = null;
  let responseId: string | undefined;
  let responseModel: string | undefined;
  let usage: TokenUsage | undefined;
  let streamDone = false;
  let idleAborted = false;

  const idleTimer = {
    id: undefined as ReturnType<typeof setTimeout> | undefined,
    arm() {
      this.clear();
      this.id = setTimeout(() => {
        idleAborted = true;
        reader.cancel().catch(() => undefined);
      }, idleTimeoutMs);
    },
    clear() {
      if (this.id) {
        clearTimeout(this.id);
        this.id = undefined;
      }
    },
  };

  const consumeEvent = (data: string) => {
    if (!data) {
      return;
    }

    if (data === "[DONE]") {
      streamDone = true;
      return;
    }

    let chunk: OpenAICompatibleChunk;

    try {
      chunk = JSON.parse(data) as OpenAICompatibleChunk;
    } catch {
      // Ignore keep-alive comments / partial frames instead of killing the stream.
      return;
    }

    onRawEvent?.(chunk);

    if (chunk.error) {
      throw createStreamError(chunk.error, response?.status);
    }

    responseId = chunk.id ?? responseId;
    responseModel = chunk.model ?? responseModel;
    usage = chunk.usage ?? usage;

    const choice = chunk.choices?.[0];
    const delta = extractText(choice?.delta?.content ?? choice?.text);
    const reasoningDelta = extractText(
      choice?.delta?.reasoning ?? choice?.delta?.reasoning_content,
    );

    if (reasoningDelta) {
      fullReasoning += reasoningDelta;
      onReasoningDelta?.(reasoningDelta, fullReasoning);
    }

    if (delta) {
      fullText += delta;
      onTextDelta?.(delta, fullText);
    }

    if (choice?.finish_reason) {
      finishReason = choice.finish_reason;
    }
  };

  const consumeLine = (line: string) => {
    const normalizedLine = line.endsWith("\r") ? line.slice(0, -1) : line;

    if (normalizedLine === "") {
      if (eventData.length > 0) {
        consumeEvent(eventData.join("\n"));
        eventData = [];
      }
      return;
    }

    if (normalizedLine.startsWith(":")) {
      // SSE comment / keep-alive ping
      return;
    }

    if (normalizedLine.startsWith("data:")) {
      eventData.push(normalizedLine.slice(5).trimStart());
    }
  };

  // The user's abort signal must also stop the stream *while it is running*.
  const streamAbort = () => {
    void reader.cancel().catch(() => undefined);
  };

  signal?.addEventListener("abort", streamAbort, { once: true });

  try {
    idleTimer.arm();

    while (!streamDone) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      idleTimer.arm();
      textBuffer += decoder.decode(value, { stream: true });

      let lineBreakIndex = textBuffer.indexOf("\n");
      while (lineBreakIndex >= 0) {
        consumeLine(textBuffer.slice(0, lineBreakIndex));
        textBuffer = textBuffer.slice(lineBreakIndex + 1);

        if (streamDone) {
          break;
        }

        lineBreakIndex = textBuffer.indexOf("\n");
      }
    }

    textBuffer += decoder.decode();

    if (!streamDone && textBuffer.length > 0) {
      consumeLine(textBuffer);
    }

    if (!streamDone && eventData.length > 0) {
      consumeEvent(eventData.join("\n"));
    }

    // `reader.cancel()` ends the loop gracefully, so both stop cases are
    // checked here – otherwise a stopped stream would look like a short answer.
    if (signal?.aborted) {
      throw abortError();
    }

    if (idleAborted && !streamDone) {
      throw idleError();
    }
  } catch (error) {
    if (idleAborted) {
      throw idleError(error);
    }

    if (signal?.aborted) {
      throw abortError();
    }

    if (error instanceof Error && error.name === "AbortError") {
      throw abortError();
    }

    throw error;
  } finally {
    signal?.removeEventListener("abort", streamAbort);
    idleTimer.clear();
    reader.releaseLock();
  }

  return {
    text: fullText,
    reasoning: fullReasoning,
    finishReason,
    responseId,
    responseModel,
    usage,
    attempts,
    aborted: false,
  };
}

export function createFileAwareMessages(
  prompt: string,
  file: FileContext,
): ChatMessage[] {
  const filePath = file.path ?? "untitled";
  const language = file.language ?? "plaintext";
  const selection = file.selection?.trim()
    ? `\n\n<selected_code>\n${file.selection}\n</selected_code>`
    : "";

  return [
    {
      role: "system",
      content:
        "You are the coding assistant inside StonedEditor. Give precise, implementation-ready answers. Preserve the project's style. When asked to edit code, return only the requested replacement unless the user asks for an explanation.",
    },
    {
      role: "user",
      content: [
        `Current file: ${filePath}`,
        `Language: ${language}`,
        "",
        "<current_file>",
        file.content,
        "</current_file>",
        selection,
        "",
        "<request>",
        prompt,
        "</request>",
      ].join("\n"),
    },
  ];
}

/**
 * Rough guard so huge files cannot blow the model's context window.
 * Returns the (possibly shortened) text plus how many characters were dropped.
 */
export function clampToContext(
  text: string,
  contextLength: number | undefined,
  reservedTokens = 4_000,
) {
  const maxChars = Math.max(
    2_000,
    Math.floor(((contextLength ?? 32_000) - reservedTokens) * 3.5 * 0.6),
  );

  if (text.length <= maxChars) {
    return { text, truncatedChars: 0 };
  }

  return {
    text: text.slice(0, maxChars),
    truncatedChars: text.length - maxChars,
  };
}

export async function streamCompletionIntoMonaco(
  options: StreamIntoMonacoOptions,
): Promise<StreamChatResult> {
  const {
    editor,
    range,
    keepCursorAtEnd = true,
    onTextDelta,
    ...requestOptions
  } = options;
  const model = editor.getModel();

  if (!model) {
    throw new OpenRouterApiError("Der Monaco Editor hat kein aktives Dokument.");
  }

  const currentPosition =
    editor.getPosition() ?? model.getFullModelRange().getEndPosition();
  const targetRange =
    range ??
    editor.getSelection() ?? {
      startLineNumber: currentPosition.lineNumber,
      startColumn: currentPosition.column,
      endLineNumber: currentPosition.lineNumber,
      endColumn: currentPosition.column,
    };

  let insertionPosition: IPosition = {
    lineNumber: targetRange.startLineNumber,
    column: targetRange.startColumn,
  };
  let queuedText = "";
  let flushScheduled = false;

  const flush = () => {
    flushScheduled = false;

    if (!queuedText) {
      return;
    }

    const chunk = queuedText;
    queuedText = "";
    const insertionRange: IRange = {
      startLineNumber: insertionPosition.lineNumber,
      startColumn: insertionPosition.column,
      endLineNumber: insertionPosition.lineNumber,
      endColumn: insertionPosition.column,
    };

    editor.executeEdits("openrouter-stream", [
      {
        range: insertionRange,
        text: chunk,
        forceMoveMarkers: true,
      },
    ]);

    insertionPosition = advancePosition(insertionPosition, chunk);

    if (keepCursorAtEnd) {
      editor.setPosition(insertionPosition);
      editor.revealPositionInCenterIfOutsideViewport(insertionPosition);
    }
  };

  const scheduleFlush = () => {
    if (flushScheduled) {
      return;
    }

    flushScheduled = true;

    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(flush);
    } else {
      setTimeout(flush, 16);
    }
  };

  editor.pushUndoStop();
  editor.executeEdits("openrouter-stream-start", [
    {
      range: targetRange,
      text: "",
      forceMoveMarkers: true,
    },
  ]);

  try {
    const result = await streamChatCompletion({
      ...requestOptions,
      onTextDelta(delta, fullText) {
        queuedText += delta;
        scheduleFlush();
        onTextDelta?.(delta, fullText);
      },
    });

    flush();
    editor.pushUndoStop();

    return result;
  } catch (error) {
    flush();
    editor.pushUndoStop();
    throw error;
  }
}

function extractText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((part) => {
      if (typeof part === "string") {
        return part;
      }

      if (
        typeof part === "object" &&
        part !== null &&
        "text" in part &&
        typeof part.text === "string"
      ) {
        return part.text;
      }

      return "";
    })
    .join("");
}

function advancePosition(position: IPosition, insertedText: string): IPosition {
  const lines = insertedText.replace(/\r\n?/g, "\n").split("\n");

  if (lines.length === 1) {
    return {
      lineNumber: position.lineNumber,
      column: position.column + lines[0].length,
    };
  }

  return {
    lineNumber: position.lineNumber + lines.length - 1,
    column: lines.at(-1)!.length + 1,
  };
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Only used in tests/tools – exponential backoff helper. */
export const __testing = { delay, isRetryableError };

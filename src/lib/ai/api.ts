import type {
  editor as MonacoEditor,
  IPosition,
  IRange,
} from "monaco-editor";

export const DEFAULT_FREEMODEL_BASE_URL =
  process.env.NEXT_PUBLIC_DEFAULT_FREEMODEL_BASE_URL ??
  "https://vip-sg.freemodel.dev/v1";

export const FREEMODEL_BASE_URLS = [
  "https://vip-sg.freemodel.dev/v1",
  "https://cc.freemodel.dev/v1",
] as const;

export const FREEMODEL_MODELS = [
  "gpt-5.5",
  "sol-5.6",
  "fable-5",
  "claude-3.5-sonnet",
] as const;

export type FreeModelName = (typeof FREEMODEL_MODELS)[number];
export type ChatRole =
  | "system"
  | "developer"
  | "user"
  | "assistant"
  | "tool";

export interface ChatMessage {
  role: ChatRole;
  content: string;
  name?: string;
  tool_call_id?: string;
}

export interface FreeModelUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export interface StreamChatResult {
  text: string;
  finishReason: string | null;
  responseId?: string;
  responseModel?: string;
  usage?: FreeModelUsage;
}

type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

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
  onTextDelta?: (delta: string, fullText: string) => void;
  onRawEvent?: (event: unknown) => void;
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

interface OpenAICompatibleChunk {
  id?: string;
  model?: string;
  error?: {
    message?: string;
    type?: string;
    code?: string | number;
  };
  choices?: Array<{
    text?: string;
    finish_reason?: string | null;
    delta?: {
      content?: unknown;
      reasoning_content?: unknown;
    };
    message?: {
      content?: unknown;
    };
  }>;
  usage?: FreeModelUsage;
}

export class FreeModelApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "FreeModelApiError";
  }
}

export function normalizeFreeModelBaseUrl(baseUrl = DEFAULT_FREEMODEL_BASE_URL) {
  let normalized = baseUrl.trim();

  if (!/^https?:\/\//i.test(normalized)) {
    normalized = `https://${normalized}`;
  }

  normalized = normalized.replace(/\/+$/, "");

  return normalized.endsWith("/v1") ? normalized : `${normalized}/v1`;
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
    onRawEvent,
  } = options;

  if (!apiKey.trim()) {
    throw new FreeModelApiError("Ein FreeModel.dev API-Key ist erforderlich.");
  }

  if (!model.trim()) {
    throw new FreeModelApiError("Ein Modell muss ausgewählt sein.");
  }

  if (messages.length === 0) {
    throw new FreeModelApiError("Mindestens eine Chat-Nachricht ist erforderlich.");
  }

  const endpoint = `${normalizeFreeModelBaseUrl(baseUrl)}/chat/completions`;
  const body: Record<string, unknown> = {
    model,
    messages,
    stream: true,
    stream_options: {
      include_usage: true,
    },
    ...extraBody,
  };

  if (temperature !== undefined) {
    body.temperature = temperature;
  }

  if (maxTokens !== undefined) {
    body.max_tokens = maxTokens;
  }

  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: {
      Accept: "text/event-stream",
      Authorization: `Bearer ${apiKey.trim()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    throw await createResponseError(response);
  }

  if (!response.body) {
    throw new FreeModelApiError(
      "Die API-Antwort enthält keinen lesbaren Stream.",
      response.status,
    );
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let textBuffer = "";
  let eventData: string[] = [];
  let fullText = "";
  let finishReason: string | null = null;
  let responseId: string | undefined;
  let responseModel: string | undefined;
  let usage: FreeModelUsage | undefined;
  let streamDone = false;

  const consumeEvent = (data: string) => {
    if (!data || data === "[DONE]") {
      streamDone = data === "[DONE]";
      return;
    }

    let chunk: OpenAICompatibleChunk;

    try {
      chunk = JSON.parse(data) as OpenAICompatibleChunk;
    } catch {
      throw new FreeModelApiError(
        "Die API hat ein ungültiges Streaming-Ereignis geliefert.",
        response.status,
        data,
      );
    }

    onRawEvent?.(chunk);

    if (chunk.error) {
      throw new FreeModelApiError(
        chunk.error.message ?? "FreeModel.dev hat einen Fehler gemeldet.",
        response.status,
        chunk.error,
      );
    }

    responseId = chunk.id ?? responseId;
    responseModel = chunk.model ?? responseModel;
    usage = chunk.usage ?? usage;

    const choice = chunk.choices?.[0];
    const delta = extractText(choice?.delta?.content ?? choice?.text);

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

    if (normalizedLine.startsWith("data:")) {
      eventData.push(normalizedLine.slice(5).trimStart());
    }
  };

  try {
    while (!streamDone) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

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
  } finally {
    reader.releaseLock();
  }

  return {
    text: fullText,
    finishReason,
    responseId,
    responseModel,
    usage,
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
    throw new FreeModelApiError("Der Monaco Editor hat kein aktives Dokument.");
  }

  const currentPosition = editor.getPosition() ?? model.getFullModelRange().getEndPosition();
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

    editor.executeEdits("freemodel-stream", [
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
  editor.executeEdits("freemodel-stream-start", [
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

async function createResponseError(response: Response) {
  const rawBody = await response.text();
  let details: unknown = rawBody;
  let message = `FreeModel.dev antwortete mit HTTP ${response.status}.`;

  if (rawBody) {
    try {
      const parsed = JSON.parse(rawBody) as {
        error?: {
          message?: string;
        };
        message?: string;
      };
      details = parsed;
      message = parsed.error?.message ?? parsed.message ?? message;
    } catch {
      message = rawBody.slice(0, 500);
    }
  }

  return new FreeModelApiError(message, response.status, details);
}

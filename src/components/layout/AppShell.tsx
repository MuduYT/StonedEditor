"use client";

import React, { useState, useEffect, useRef, useMemo } from "react";
import Editor, { Monaco } from "@monaco-editor/react";
import type { editor as MonacoEditorType } from "monaco-editor";
import {
  Folder,
  File,
  ChevronRight,
  ChevronDown,
  Settings,
  Send,
  Sparkles,
  Key,
  Globe,
  Loader2,
  Code,
  Bug,
  HelpCircle,
  FileCode,
  Trash2,
  FolderOpen,
  Save,
  PanelRightClose,
  PanelRightOpen,
  RefreshCw,
  CircleStop,
  Copy,
  Eye,
  EyeOff,
  Wallet,
  ShieldCheck,
  CircleAlert,
  RotateCcw,
  Brain,
  Zap,
} from "lucide-react";
import {
  Panel,
  Group as PanelGroup,
  Separator as PanelResizeHandle,
} from "react-resizable-panels";
import { Toaster, toast } from "sonner";
import {
  OPENROUTER_BASE_URL,
  OPENROUTER_BASE_URLS,
  OPENROUTER_FREE_MODELS_URL,
  OPENROUTER_KEYS_URL,
  clampToContext,
  createFileAwareMessages,
  describeError,
  fetchOpenRouterKeyInfo,
  isUserAbort,
  OpenRouterApiError,
  normalizeOpenRouterBaseUrl,
  streamChatCompletion,
  streamCompletionIntoMonaco,
  type ChatMessage,
  type FileContext,
  type OpenRouterKeyInfo,
} from "../../lib/ai/api";
import {
  STORAGE_KEYS,
  displayName,
  findModel,
  freeFallbackIds,
  loadModelCatalog,
  pickDefaultModel,
  type AiModel,
  type CatalogSource,
} from "../../lib/ai/models";
import { ModelPicker } from "../chat/ModelPicker";

// Tauri dynamic imports to avoid SSR issues
let openDialog: any = null;
let readTextFileFn: any = null;
let writeTextFileFn: any = null;

if (typeof window !== "undefined" && (window as any).__TAURI_INTERNALS__) {
  import("@tauri-apps/plugin-dialog").then((m) => {
    openDialog = m.open;
  });
  import("@tauri-apps/plugin-fs").then((m) => {
    readTextFileFn = m.readTextFile;
    writeTextFileFn = m.writeTextFile;
  });
}

/**
 * Some free reasoning models stream thinking forever without ever answering.
 * After this time without a single content token the app switches to the next
 * free model instead of waiting indefinitely.
 */
const FREE_CONTENT_WATCHDOG_MS = 120_000;

interface FileItem {
  name: string;
  path: string;
  content: string;
  language: string;
  isFolder: boolean;
  children?: FileItem[];
}

/** Chat message plus UI-only state (model, reasoning, errors). */
interface UiChatMessage extends ChatMessage {
  modelId?: string;
  reasoning?: string;
  errorText?: string;
  aborted?: boolean;
  /** The failure is most likely fixed by picking another model. */
  suggestOtherModel?: boolean;
  /** Model that actually answered (differs after an automatic failover). */
  answeredBy?: string;
}

export function AppShell() {
  // Config & Settings
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState(OPENROUTER_BASE_URL);
  // Empty until the catalogue is known: the default is then resolved from the
  // measured reliable free models instead of a hardcoded slug.
  const [selectedModelId, setSelectedModelId] = useState("");
  const [favorites, setFavorites] = useState<string[]>([]);
  const [showSettings, setShowSettings] = useState(false);
  const [tempApiKey, setTempApiKey] = useState("");
  const [tempBaseUrl, setTempBaseUrl] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  const [keyInfo, setKeyInfo] = useState<OpenRouterKeyInfo | null>(null);
  const [keyChecking, setKeyChecking] = useState(false);

  // Model catalogue
  const [models, setModels] = useState<AiModel[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [catalogSource, setCatalogSource] = useState<CatalogSource>("live");
  const [catalogError, setCatalogError] = useState<string | null>(null);

  // UI Panels
  const [showChat, setShowChat] = useState(true);
  const [mounted, setMounted] = useState(false);

  // VFS & Files
  const [files, setFiles] = useState<FileItem[]>([]);
  const [activeFile, setActiveFile] = useState<FileItem | null>(null);
  const [expandedFolders, setExpandedFolders] = useState<Record<string, boolean>>({});
  const [openedFolderRoot, setOpenedFolderRoot] = useState<string | null>(null);

  // Chat
  const [chatMessages, setChatMessages] = useState<UiChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamStatus, setStreamStatus] = useState<string | null>(null);
  const [lastPrompt, setLastPrompt] = useState<string | null>(null);

  // Monaco Editor Ref
  const editorRef = useRef<MonacoEditorType.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<Monaco | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const chatEndRef = useRef<HTMLDivElement | null>(null);

  const selectedModel = useMemo(
    () => findModel(models, selectedModelId),
    [models, selectedModelId],
  );

  /* ---------------------------------------------------------------- *
   *  1. Restore settings + migrate the old FreeModel.dev keys
   * ---------------------------------------------------------------- */
  useEffect(() => {
    const read = (key: string, legacyKey: string) =>
      localStorage.getItem(key) ?? localStorage.getItem(legacyKey) ?? "";

    const restoredKey = read(STORAGE_KEYS.apiKey, STORAGE_KEYS.legacy.apiKey);
    const restoredUrl =
      read(STORAGE_KEYS.baseUrl, STORAGE_KEYS.legacy.baseUrl) || OPENROUTER_BASE_URL;
    const restoredModel = read(STORAGE_KEYS.model, STORAGE_KEYS.legacy.model);

    if (restoredKey) localStorage.setItem(STORAGE_KEYS.apiKey, restoredKey);
    if (restoredUrl) localStorage.setItem(STORAGE_KEYS.baseUrl, restoredUrl);
    if (restoredModel) localStorage.setItem(STORAGE_KEYS.model, restoredModel);

    try {
      const storedFavorites = JSON.parse(
        localStorage.getItem(STORAGE_KEYS.favorites) ?? "[]",
      ) as string[];
      setFavorites(Array.isArray(storedFavorites) ? storedFavorites : []);
    } catch {
      setFavorites([]);
    }

    setApiKey(restoredKey);
    setBaseUrl(normalizeOpenRouterBaseUrl(restoredUrl));
    setTempApiKey(restoredKey);
    setTempBaseUrl(restoredUrl);
    if (restoredModel) setSelectedModelId(restoredModel);

    if (!restoredKey) {
      setShowSettings(true);
    }

    // Set up dummy virtual workspace files
    const virtualWorkspace: FileItem[] = [
      {
        name: "src",
        path: "src",
        content: "",
        language: "",
        isFolder: true,
        children: [
          {
            name: "app",
            path: "src/app",
            content: "",
            language: "",
            isFolder: true,
            children: [
              {
                name: "page.tsx",
                path: "src/app/page.tsx",
                content: `import { AppShell } from "@/components/layout/AppShell";\n\nexport default function HomePage() {\n  return <AppShell />;\n}`,
                language: "typescript",
                isFolder: false,
              },
              {
                name: "globals.css",
                path: "src/app/globals.css",
                content: `@import "tailwindcss";\n\n:root {\n  color-scheme: dark;\n  --background: #0b0d10;\n  --foreground: #e7e9ee;\n  --panel: #11141a;\n  --border: #252a34;\n  --muted: #939aa7;\n  --accent: #7c6cff;\n}`,
                language: "css",
                isFolder: false,
              }
            ]
          },
          {
            name: "lib",
            path: "src/lib",
            content: "",
            language: "",
            isFolder: true,
            children: [
              {
                name: "utils.ts",
                path: "src/lib/utils.ts",
                content: `import { clsx, type ClassValue } from "clsx";\nimport { twMerge } from "tailwind-merge";\n\nexport function cn(...inputs: ClassValue[]) {\n  return twMerge(clsx(inputs));\n}`,
                language: "typescript",
                isFolder: false,
              }
            ]
          }
        ]
      },
      {
        name: "package.json",
        path: "package.json",
        content: `{\n  "name": "stoned-editor",\n  "version": "0.1.0",\n  "dependencies": {\n    "@tauri-apps/api": "^2.11.1",\n    "next": "^16.2.10",\n    "react": "^19.2.7"\n  }\n}`,
        language: "json",
        isFolder: false,
      },
      {
        name: "next.config.ts",
        path: "next.config.ts",
        content: `import type { NextConfig } from "next";\n\nconst nextConfig: NextConfig = {\n  output: "export",\n  images: { unoptimized: true }\n};\n\nexport default nextConfig;`,
        language: "typescript",
        isFolder: false,
      }
    ];

    setFiles(virtualWorkspace);
    // Open default file
    setActiveFile(virtualWorkspace[0].children![0].children![0]);
    setExpandedFolders({ "src": true, "src/app": true });
    setMounted(true);
  }, []);

  /* ---------------------------------------------------------------- *
   *  2. Load models from OpenRouter
   * ---------------------------------------------------------------- */
  const loadModels = React.useCallback(
    async (options: { force?: boolean; silent?: boolean } = {}) => {
      setModelsLoading(true);

      try {
        const catalog = await loadModelCatalog({ baseUrl, force: options.force });

        setModels(catalog.models);
        setCatalogSource(catalog.source);
        setCatalogError(catalog.error ? describeError(catalog.error) : null);

        // Only warn when the live catalogue actually failed – a cached list is
        // a normal, silent fallback.
        if (catalog.error && !options.silent) {
          toast.warning(
            catalog.source === "fallback"
              ? "OpenRouter nicht erreichbar – Notliste geladen. Internetverbindung prüfen."
              : "OpenRouter nicht erreichbar – die zuletzt geladene Modellliste wird verwendet.",
          );
        } else if (options.silent && catalog.models.length > 0) {
          const count = catalog.models.filter((model) => model.isFree).length;
          toast.success(`${catalog.models.length} Modelle geladen (${count} kostenlos)`);
        }
      } finally {
        setModelsLoading(false);
      }
    },
    [baseUrl],
  );

  useEffect(() => {
    void loadModels();
  }, [loadModels]);

  // Keep the stored model valid once the catalogue is known.
  useEffect(() => {
    if (models.length === 0) {
      return;
    }

    const resolved = pickDefaultModel(models, selectedModelId || null);

    if (resolved && resolved !== selectedModelId) {
      setSelectedModelId(resolved);
      localStorage.setItem(STORAGE_KEYS.model, resolved);
    }
  }, [models, selectedModelId]);

  // Auto-scroll the chat while streaming.
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ block: "end" });
  }, [chatMessages, isStreaming]);

  /* ---------------------------------------------------------------- *
   *  3. Settings
   * ---------------------------------------------------------------- */
  const handleSaveSettings = () => {
    const normalizedUrl = normalizeOpenRouterBaseUrl(tempBaseUrl);

    localStorage.setItem(STORAGE_KEYS.apiKey, tempApiKey.trim());
    localStorage.setItem(STORAGE_KEYS.baseUrl, normalizedUrl);
    setApiKey(tempApiKey.trim());
    setBaseUrl(normalizedUrl);
    setKeyInfo(null);
    setShowSettings(false);
    toast.success("Einstellungen gespeichert");

    if (normalizedUrl !== baseUrl) {
      void loadModels({ force: true });
    }
  };

  const handleTestKey = async () => {
    const keyToTest = tempApiKey.trim();

    if (!keyToTest) {
      toast.error("Bitte zuerst einen API-Key eingeben.");
      return;
    }

    setKeyChecking(true);
    setKeyInfo(null);

    try {
      const info = await fetchOpenRouterKeyInfo({ apiKey: keyToTest, baseUrl: tempBaseUrl });
      setKeyInfo(info);
      const credits =
        typeof info.limit_remaining === "number"
          ? `Restguthaben: $${info.limit_remaining.toFixed(2)}`
          : typeof info.limit === "number"
            ? `Limit: $${info.limit.toFixed(2)}`
            : "kein festes Limit";
      toast.success(`Key funktioniert (${info.label ?? "OpenRouter"}) · ${credits}`);
    } catch (error) {
      toast.error(describeError(error));
    } finally {
      setKeyChecking(false);
    }
  };

  const handleSelectModel = (modelId: string) => {
    setSelectedModelId(modelId);
    localStorage.setItem(STORAGE_KEYS.model, modelId);

    const model = models.find((entry) => entry.id === modelId);

    if (model) {
      toast.success(
        `${displayName(model)}${model.isFree ? " · kostenlos" : ""}`,
        { description: model.isFree ? "Free-Modelle sind stark limitiert." : undefined },
      );
    }
  };

  const handleToggleFavorite = (modelId: string) => {
    setFavorites((prev) => {
      const next = prev.includes(modelId)
        ? prev.filter((id) => id !== modelId)
        : [...prev, modelId];

      localStorage.setItem(STORAGE_KEYS.favorites, JSON.stringify(next));

      return next;
    });
  };

  /* ---------------------------------------------------------------- *
   *  4. Files
   * ---------------------------------------------------------------- */
  const toggleFolder = (path: string) => {
    setExpandedFolders(prev => ({
      ...prev,
      [path]: !prev[path]
    }));
  };

  const selectFile = (file: FileItem) => {
    if (file.isFolder) return;
    setActiveFile(file);
  };

  const handleSaveFile = async () => {
    if (!activeFile) return;

    const currentContent = editorRef.current?.getValue() || "";

    // Update local react state
    const updateFileContent = (list: FileItem[]): FileItem[] => {
      return list.map(item => {
        if (item.path === activeFile.path) {
          return { ...item, content: currentContent };
        }
        if (item.children) {
          return { ...item, children: updateFileContent(item.children) };
        }
        return item;
      });
    };

    setFiles(prev => updateFileContent(prev));
    setActiveFile(prev => prev ? { ...prev, content: currentContent } : null);

    // Save to real FS if in Tauri
    if (writeTextFileFn && openedFolderRoot) {
      try {
        await writeTextFileFn(activeFile.path, currentContent);
        toast.success("Datei auf Festplatte gespeichert!");
      } catch (err: any) {
        toast.error(`Fehler beim Speichern der Datei: ${err.message || err}`);
      }
    } else {
      toast.success("Virtuelle Datei gespeichert!");
    }
  };

  const handleOpenFolder = async () => {
    if (!openDialog || !readTextFileFn) {
      toast.error("Tauri-Schnittstelle ist im Browser-Modus nicht verfügbar.");
      return;
    }

    try {
      const selected = await openDialog({
        directory: true,
        multiple: false,
        title: "Projektordner öffnen"
      });

      if (!selected || typeof selected !== "string") return;

      toast.loading("Ordnerstruktur wird geladen...");
      setOpenedFolderRoot(selected);

      const projectFiles: FileItem[] = [
        {
          name: "src",
          path: `${selected}/src`,
          content: "",
          language: "",
          isFolder: true,
          children: [
            {
              name: "app",
              path: `${selected}/src/app`,
              content: "",
              language: "",
              isFolder: true,
              children: [
                {
                  name: "page.tsx",
                  path: `${selected}/src/app/page.tsx`,
                  content: await readTextFileFn(`${selected}/src/app/page.tsx`),
                  language: "typescript",
                  isFolder: false,
                },
                {
                  name: "globals.css",
                  path: `${selected}/src/app/globals.css`,
                  content: await readTextFileFn(`${selected}/src/app/globals.css`),
                  language: "css",
                  isFolder: false,
                }
              ]
            },
            {
              name: "lib",
              path: `${selected}/src/lib`,
              content: "",
              language: "",
              isFolder: true,
              children: [
                {
                  name: "utils.ts",
                  path: `${selected}/src/lib/utils.ts`,
                  content: await readTextFileFn(`${selected}/src/lib/utils.ts`),
                  language: "typescript",
                  isFolder: false,
                },
                {
                  name: "ai",
                  path: `${selected}/src/lib/ai`,
                  content: "",
                  language: "",
                  isFolder: true,
                  children: [
                    {
                      name: "api.ts",
                      path: `${selected}/src/lib/ai/api.ts`,
                      content: await readTextFileFn(`${selected}/src/lib/ai/api.ts`),
                      language: "typescript",
                      isFolder: false,
                    },
                    {
                      name: "models.ts",
                      path: `${selected}/src/lib/ai/models.ts`,
                      content: await readTextFileFn(`${selected}/src/lib/ai/models.ts`),
                      language: "typescript",
                      isFolder: false,
                    }
                  ]
                }
              ]
            }
          ]
        },
        {
          name: "package.json",
          path: `${selected}/package.json`,
          content: await readTextFileFn(`${selected}/package.json`),
          language: "json",
          isFolder: false,
        },
        {
          name: "next.config.ts",
          path: `${selected}/next.config.ts`,
          content: await readTextFileFn(`${selected}/next.config.ts`),
          language: "typescript",
          isFolder: false,
        }
      ];

      setFiles(projectFiles);
      setOpenedFolderRoot(selected);
      setActiveFile(projectFiles[0].children![0].children![0]); // page.tsx
      toast.dismiss();
      toast.success("Projektordner erfolgreich geöffnet!");
    } catch (err: any) {
      toast.dismiss();
      toast.error(`Fehler beim Öffnen des Ordners: ${err.message || err}`);
    }
  };

  /* ---------------------------------------------------------------- *
   *  5. Chat streaming
   * ---------------------------------------------------------------- */
  const patchLastMessage = (patch: Partial<UiChatMessage>) => {
    setChatMessages((prev) => {
      if (prev.length === 0) {
        return prev;
      }

      const next = [...prev];
      next[next.length - 1] = { ...next[next.length - 1], ...patch };

      return next;
    });
  };

  const buildApiMessages = (
    history: UiChatMessage[],
    promptText: string,
    fileContext: FileContext,
  ) => {
    const usable = history.filter(
      (message) =>
        message.role === "user" ||
        (message.role === "assistant" && !message.errorText && message.content.trim().length > 0),
    );

    const prior =
      usable.length > 0 && usable[usable.length - 1].role === "user"
        ? usable.slice(0, -1)
        : usable;

    const [systemMessage, userMessage] = createFileAwareMessages(promptText, fileContext);

    return [
      systemMessage,
      ...prior.map(({ role, content }) => ({ role, content })),
      userMessage,
    ];
  };

  const startStream = async (
    promptText: string,
    history: UiChatMessage[],
    options: { modelId?: string } = {},
  ) => {
    const model =
      (options.modelId ? findModel(models, options.modelId) : undefined) ?? selectedModel;

    if (!apiKey.trim()) {
      toast.error("Bitte zuerst deinen OpenRouter API-Key eintragen.");
      setShowSettings(true);
      return;
    }

    if (!model) {
      toast.error("Bitte wähle im Chatfenster ein Modell aus.");
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLastPrompt(promptText);
    setIsStreaming(true);
    setStreamStatus(null);
    setChatMessages([...history, { role: "assistant", content: "", modelId: model.id }]);

    // File context, clamped to the model's context window.
    let fileContext: FileContext = { content: "" };

    if (activeFile) {
      const rawContent = editorRef.current?.getValue() || activeFile.content;
      const { text, truncatedChars } = clampToContext(
        rawContent,
        model.contextLength || selectedModel?.contextLength,
      );

      if (truncatedChars > 0) {
        toast.info(
          `Datei für das Kontextfenster gekürzt (${truncatedChars.toLocaleString("de-DE")} Zeichen).`,
        );
      }

      const selectionRange = editorRef.current?.getSelection();

      fileContext = {
        path: activeFile.path,
        language: activeFile.language,
        content: text,
        selection: selectionRange
          ? editorRef.current?.getModel()?.getValueInRange(selectionRange) ?? ""
          : "",
      };
    }

    const messages = buildApiMessages(history, promptText, fileContext);

    /**
     * Free endpoints sit in a shared upstream pool: they can fail or even answer
     * with nothing but reasoning tokens. OpenRouter already fails over *inside*
     * one request (`models`), and these candidates continue in the same bubble if
     * that whole request comes back empty. Paid models are never auto-switched.
     */
    const candidates = model.isFree
      ? [model.id, ...freeFallbackIds(models, model.id)]
      : [model.id];

    let accumulated = "";
    let reasoning = "";
    let answeredBy: string | undefined;

    try {
      for (let index = 0; index < candidates.length; index += 1) {
        const candidateId = candidates[index];
        const candidate = findModel(models, candidateId) ?? model;
        const isLastCandidate = index === candidates.length - 1;
        const nextId = isLastCandidate ? undefined : candidates[index + 1];
        const nextModel = nextId ? findModel(models, nextId) : undefined;
        const fallbackChain = candidate.isFree
          ? [candidateId, ...freeFallbackIds(models, candidateId)]
          : [];

        accumulated = "";
        reasoning = "";
        answeredBy = undefined;

        patchLastMessage({
          modelId: candidateId,
          content: "",
          reasoning: undefined,
          errorText: undefined,
          answeredBy: undefined,
        });

        let attemptError: unknown = null;

        // The user's stop must reach the request, but the watchdog abort below
        // must NOT look like a user stop – hence the per-attempt controller.
        const attemptController = new AbortController();
        const forwardStop = () => attemptController.abort();
        controller.signal.addEventListener("abort", forwardStop, { once: true });
        let watchdogFired = false;
        const watchdog = candidate.isFree
          ? setTimeout(() => {
              watchdogFired = true;
              attemptController.abort();
            }, FREE_CONTENT_WATCHDOG_MS)
          : undefined;
        const clearWatchdog = () => {
          if (watchdog) {
            clearTimeout(watchdog);
          }
        };

        try {
          if (index > 0) {
            setStreamStatus(`Wechsle zu ${displayName(candidate)} …`);
          }

          await streamChatCompletion({
            apiKey,
            baseUrl,
            model: candidateId,
            messages,
            signal: attemptController.signal,
            ...(candidate.supportsTemperature ? { temperature: 0.2 } : {}),
            ...(fallbackChain.length > 0
              ? { extraBody: { models: fallbackChain } }
              : {}),
            onTextDelta(delta) {
              clearWatchdog();
              accumulated += delta;
              patchLastMessage({
                content: accumulated,
                reasoning: reasoning || undefined,
                answeredBy,
              });
            },
            onRawEvent(event) {
              const respondingModel = (event as { model?: string } | null)?.model;

              if (respondingModel && respondingModel !== answeredBy) {
                answeredBy = respondingModel;
                patchLastMessage({
                  content: accumulated,
                  answeredBy: respondingModel,
                });
              }
            },
            onReasoningDelta(_delta, full) {
              reasoning = full;
              patchLastMessage({ reasoning: full, content: accumulated });
            },
            onRetry(info) {
              setStreamStatus(
                `Versuch ${info.attempt}/${info.maxAttempts} nach ${Math.round(info.delayMs / 1000)}s – ${info.reason}`,
              );
            },
          });
        } catch (error) {
          if (controller.signal.aborted) {
            patchLastMessage({
              content: accumulated,
              aborted: true,
              reasoning: reasoning || undefined,
              answeredBy,
            });
            toast.info("Antwort gestoppt.");
            return;
          }

          attemptError = watchdogFired
            ? new OpenRouterApiError(
                `${displayName(candidate)} hat nur Denk-Tokens geliefert, aber keine Antwort.`,
                { retryable: true, suggestOtherModel: true },
              )
            : error;
        } finally {
          clearWatchdog();
          controller.signal.removeEventListener("abort", forwardStop);
        }

        // Success: real text arrived.
        if (!attemptError && accumulated.trim().length > 0) {
          patchLastMessage({
            content: accumulated,
            reasoning: reasoning || undefined,
            answeredBy,
          });
          return;
        }

        const problem =
          attemptError !== null
            ? describeError(attemptError)
            : reasoning
              ? "das Modell hat nur gedacht, aber nichts geantwortet"
              : "leere Antwort";

        if (isLastCandidate) {
          if (attemptError) {
            patchLastMessage({
              content: accumulated,
              errorText: problem,
              suggestOtherModel:
                attemptError instanceof OpenRouterApiError
                  ? attemptError.suggestOtherModel
                  : true,
              reasoning: reasoning || undefined,
              answeredBy,
            });
            toast.error(problem);
          } else {
            patchLastMessage({
              content: accumulated,
              reasoning: reasoning || undefined,
              answeredBy,
              errorText: reasoning
                ? "Das Modell hat nur gedacht, aber keine Antwort geschrieben (typisch bei knappen Free-Limits). Wähle ein anderes Modell und versuche es erneut."
                : "Das Modell hat keine Antwort geliefert (leere Antwort). Wähle ein anderes Modell oder versuche es erneut.",
              suggestOtherModel: true,
            });
            toast.warning(`Kein Ergebnis von ${displayName(candidate)}.`);
          }

          return;
        }

        toast.info(
          `${displayName(candidate)}: ${problem} – nächster Versuch mit ${displayName(nextModel ?? candidate)}`,
        );
      }
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
      }
      setStreamStatus(null);
      setIsStreaming(false);
    }
  };

  const handleSendChatMessage = (overridePrompt?: string) => {
    const promptText = (overridePrompt ?? chatInput).trim();

    if (!promptText) return;
    if (isStreaming) {
      toast.info("Warte, bis die aktuelle Antwort fertig ist (oder stoppe sie).");
      return;
    }

    if (!overridePrompt) setChatInput("");

    const userMessage: UiChatMessage = { role: "user", content: promptText };
    void startStream(promptText, [...chatMessages, userMessage]);
  };

  /** Removes a trailing assistant bubble (error/aborted) before a retry. */
  const historyWithoutTrailingAnswer = (history: UiChatMessage[]) =>
    history.filter((message, index) => {
      const isLast = index === history.length - 1;
      return !(isLast && message.role === "assistant");
    });

  const handleRetryLastAnswer = () => {
    if (!lastPrompt || isStreaming) return;

    void startStream(lastPrompt, historyWithoutTrailingAnswer(chatMessages));
  };

  /** Rotates to the next free model and re-sends the last prompt. */
  const handleTryAnotherFreeModel = () => {
    if (isStreaming) return;

    const freeModels = models.filter((model) => model.isFree);

    if (freeModels.length < 2) {
      toast.error("Es ist gerade kein anderes kostenloses Modell verfügbar.");
      return;
    }

    const currentIndex = freeModels.findIndex((model) => model.id === selectedModelId);
    const next = freeModels[(currentIndex + 1) % freeModels.length];

    handleSelectModel(next.id);

    if (!lastPrompt) {
      return;
    }

    void startStream(lastPrompt, historyWithoutTrailingAnswer(chatMessages), {
      modelId: next.id,
    });
  };

  const handleStopStreaming = () => {
    abortRef.current?.abort();
  };

  /* ---------------------------------------------------------------- *
   *  6. AI actions in the editor
   * ---------------------------------------------------------------- */
  const handleAIInlineEdit = async () => {
    if (!editorRef.current || !activeFile) return;

    if (!apiKey) {
      toast.error("Bitte gib zuerst deinen OpenRouter API-Key in den Einstellungen ein.");
      setShowSettings(true);
      return;
    }

    if (!selectedModel) {
      toast.error("Bitte wähle zuerst ein Modell aus.");
      return;
    }

    const selection = editorRef.current.getSelection();
    if (!selection) {
      toast.error("Wähle zuerst einen Codebereich im Editor aus, den die KI bearbeiten soll.");
      return;
    }

    const selectedText = editorRef.current.getModel()?.getValueInRange(selection) || "";
    if (!selectedText.trim()) {
      toast.error("Die Auswahl ist leer.");
      return;
    }

    const instruction = prompt("Was soll an dem ausgewählten Code geändert werden?");
    if (!instruction) return;

    const controller = new AbortController();
    abortRef.current = controller;
    setIsStreaming(true);
    toast.info(`Generiere Code mit ${displayName(selectedModel)} …`);

    const { text: fileContent } = clampToContext(
      editorRef.current.getValue(),
      selectedModel.contextLength,
    );

    const fileContext = {
      path: activeFile.path,
      language: activeFile.language,
      content: fileContent,
      selection: selectedText
    };

    const promptMessage = `Passe folgenden ausgewählten Codebereich an:\n\n${selectedText}\n\nAnweisung: ${instruction}\n\nAntworte AUSSCHLIESSLICH mit dem neuen Ersatz-Code. Keine Erklärungen, kein Markdown-Codeblock.`;

    const messages = createFileAwareMessages(promptMessage, fileContext);

    try {
      await streamCompletionIntoMonaco({
        editor: editorRef.current,
        range: selection,
        apiKey,
        baseUrl,
        model: selectedModel.id,
        messages,
        signal: controller.signal,
        ...(selectedModel.supportsTemperature ? { temperature: 0.2 } : {}),
        keepCursorAtEnd: true
      });
      toast.success("Code erfolgreich inline eingefügt!");
    } catch (error) {
      if (isUserAbort(error)) {
        toast.info("Inline-Generierung gestoppt.");
      } else {
        toast.error(`Fehler bei Inline-Generierung: ${describeError(error)}`);
      }
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
      }
      setIsStreaming(false);
    }
  };

  // AI Explain Selection
  const handleAIExplainCode = () => {
    if (!editorRef.current) return;
    const selection = editorRef.current.getSelection();
    const selectedText = editorRef.current.getModel()?.getValueInRange(selection!) || "";

    if (!selectedText.trim()) {
      toast.error("Wähle zuerst den Code aus, den du erklärt haben möchtest.");
      return;
    }

    if (!showChat) setShowChat(true);

    handleSendChatMessage(`Erkläre mir diesen Codebereich:\n\n\`\`\`${activeFile?.language || "javascript"}\n${selectedText}\n\`\`\``);
  };

  const handleCopyMessage = async (content: string) => {
    try {
      await navigator.clipboard.writeText(content);
      toast.success("In die Zwischenablage kopiert");
    } catch {
      toast.error("Kopieren nicht möglich");
    }
  };

  /* ---------------------------------------------------------------- *
   *  7. Rendering helpers
   * ---------------------------------------------------------------- */
  const renderFileTree = (items: FileItem[], depth = 0): React.ReactNode => {
    return items.map(item => {
      const isExpanded = expandedFolders[item.path];
      const isActive = activeFile?.path === item.path;

      if (item.isFolder) {
        return (
          <div key={item.path} className="select-none">
            <button
              onClick={() => toggleFolder(item.path)}
              className="w-full flex items-center gap-2 py-1.5 px-2 hover:bg-[#ffffff08] rounded text-sm text-[#939aa7] transition"
              style={{ paddingLeft: `${depth * 12 + 8}px` }}
            >
              {isExpanded ? (
                <ChevronDown className="h-4 w-4 shrink-0 text-[#939aa7]" />
              ) : (
                <ChevronRight className="h-4 w-4 shrink-0 text-[#939aa7]" />
              )}
              <Folder className="h-4 w-4 text-[#7c6cff] shrink-0 fill-[#7c6cff1a]" />
              <span className="truncate text-[#e7e9ee] font-medium">{item.name}</span>
            </button>
            {isExpanded && item.children && (
              <div className="mt-0.5">
                {renderFileTree(item.children, depth + 1)}
              </div>
            )}
          </div>
        );
      } else {
        return (
          <button
            key={item.path}
            onClick={() => selectFile(item)}
            className={`w-full flex items-center gap-2 py-1.5 px-2 rounded text-sm transition text-left ${
              isActive
                ? "bg-[#7c6cff1c] text-[#7c6cff] border-l-2 border-[#7c6cff]"
                : "hover:bg-[#ffffff05] text-[#939aa7] hover:text-[#e7e9ee]"
            }`}
            style={{ paddingLeft: `${depth * 12 + 20}px` }}
          >
            <FileCode className="h-4 w-4 shrink-0 opacity-80" />
            <span className="truncate">{item.name}</span>
          </button>
        );
      }
    });
  };

  const modelPicker = (variant: "chat" | "compact") => (
    <ModelPicker
      models={models}
      loading={modelsLoading}
      source={catalogSource}
      catalogError={catalogError}
      selectedModelId={selectedModelId}
      favorites={favorites}
      onSelect={handleSelectModel}
      onToggleFavorite={handleToggleFavorite}
      onReload={() => void loadModels({ force: true, silent: true })}
      variant={variant}
    />
  );

  return (
    <div className="h-screen w-screen flex flex-col bg-[#0b0d10] text-[#e7e9ee] overflow-hidden">
      <Toaster position="top-right" theme="dark" closeButton />

      {/* Top Header */}
      <header className="h-14 border-b border-[#252a34] bg-[#11141a] px-4 flex items-center justify-between z-10 select-none">
        <div className="flex items-center gap-3">
          <div className="h-8 w-8 rounded-lg bg-gradient-to-tr from-[#7c6cff] to-[#a38fff] flex items-center justify-center shadow-lg shadow-[#7c6cff2a]">
            <Sparkles className="h-4 w-4 text-white fill-white/10" />
          </div>
          <div>
            <span className="font-semibold bg-gradient-to-r from-white to-[#b9bcf2] bg-clip-text text-transparent">
              StonedEditor
            </span>
            <span className="text-[10px] text-[#7c6cff] ml-1.5 font-bold uppercase tracking-wider px-1 bg-[#7c6cff1a] rounded">
              OpenRouter
            </span>
          </div>
        </div>

        {/* Top middle bar: active file info */}
        {activeFile && (
          <div className="hidden md:flex items-center gap-2 px-3 py-1 bg-[#ffffff05] rounded-full border border-[#252a34] text-xs max-w-sm">
            <File className="h-3.5 w-3.5 text-[#939aa7]" />
            <span className="text-[#939aa7] truncate">{activeFile.path}</span>
            <button
              onClick={handleSaveFile}
              className="p-1 hover:bg-[#ffffff10] rounded text-[#7c6cff] transition ml-1"
              title="Speichern (Strg+S)"
            >
              <Save className="h-3 w-3" />
            </button>
          </div>
        )}

        <div className="flex items-center gap-3">
          {/* Model Selector */}
          {modelPicker("compact")}

          {/* Settings Trigger */}
          <button
            onClick={() => {
              setTempApiKey(apiKey);
              setTempBaseUrl(baseUrl);
              setKeyInfo(null);
              setShowSettings(true);
            }}
            className="p-2 hover:bg-[#ffffff08] border border-[#252a34] rounded-lg text-[#939aa7] hover:text-[#e7e9ee] transition"
            title="Einstellungen"
          >
            <Settings className="h-4.5 w-4.5" />
          </button>

          {/* Toggle Chat Panel */}
          <button
            onClick={() => setShowChat(!showChat)}
            className={`p-2 border rounded-lg transition ${
              showChat
                ? "bg-[#7c6cff15] border-[#7c6cff50] text-[#7c6cff]"
                : "border-[#252a34] text-[#939aa7] hover:text-[#e7e9ee] hover:bg-[#ffffff08]"
            }`}
            title="AI Chat ein-/ausblenden"
          >
            {showChat ? <PanelRightClose className="h-4.5 w-4.5" /> : <PanelRightOpen className="h-4.5 w-4.5" />}
          </button>
        </div>
      </header>

      {/* Main Workspace Layout */}
      <div className="flex-1 w-full relative overflow-hidden">
        <PanelGroup orientation="horizontal">

        {/* Left Sidebar - File Explorer */}
        <Panel defaultSize="20" minSize="15" maxSize="30">
          <div className="h-full flex flex-col bg-[#11141a] border-r border-[#252a34]">
            {/* Explorer Title */}
            <div className="p-3 border-b border-[#252a34] flex items-center justify-between select-none">
              <span className="text-xs font-bold uppercase tracking-wider text-[#939aa7]">
                Projekt-Explorer
              </span>
              {mounted && openDialog && (
                <button
                  onClick={handleOpenFolder}
                  className="p-1 hover:bg-[#ffffff08] rounded text-[#7c6cff] transition flex items-center gap-1 text-[11px] font-semibold border border-[#7c6cff3a] px-2"
                >
                  <FolderOpen className="h-3.5 w-3.5" />
                  <span>Ordner</span>
                </button>
              )}
            </div>

            {/* Files Tree */}
            <div className="flex-1 overflow-y-auto p-2 space-y-1">
              {files.length > 0 ? (
                renderFileTree(files)
              ) : (
                <div className="h-full flex flex-col items-center justify-center p-4 text-center">
                  <Folder className="h-8 w-8 text-[#252a34] mb-2" />
                  <span className="text-xs text-[#939aa7]">Keine Dateien geladen</span>
                </div>
              )}
            </div>

            {/* Bottom API Key Quick Indicator */}
            <div className="p-3 border-t border-[#252a34] bg-[#0b0d10] text-[11px] text-[#939aa7] flex items-center justify-between">
              <span className="flex items-center gap-1">
                {apiKey ? (
                  <ShieldCheck className="h-3 w-3 text-emerald-400" />
                ) : (
                  <Key className="h-3 w-3 text-[#7c6cff]" />
                )}
                OpenRouter: {apiKey ? "verbunden" : "kein Key"}
              </span>
              <button
                onClick={() => {
                  setTempApiKey(apiKey);
                  setTempBaseUrl(baseUrl);
                  setShowSettings(true);
                }}
                className="text-[#7c6cff] font-semibold hover:underline"
              >
                {apiKey ? "Ändern" : "Einrichten"}
              </button>
            </div>
          </div>
        </Panel>

        {/* Split Resizer */}
        <PanelResizeHandle className="w-1 bg-[#0b0d10] hover:bg-[#7c6cff33] active:bg-[#7c6cff] transition cursor-col-resize z-10" />

        {/* Center Editor */}
        <Panel defaultSize="50" minSize="30">
          <div className="h-full flex flex-col bg-[#0b0d10]">
            {/* Editor Tabs bar */}
            <div className="h-10 border-b border-[#252a34] bg-[#11141a] px-4 flex items-center justify-between select-none">
              <div className="flex items-center gap-2">
                <FileCode className="h-4 w-4 text-[#7c6cff]" />
                <span className="text-sm font-semibold truncate text-[#e7e9ee]">
                  {activeFile ? activeFile.name : "Keine Datei ausgewählt"}
                </span>
              </div>

              {/* AI Quick Actions on Code selection */}
              {activeFile && (
                <div className="flex items-center gap-2">
                  <button
                    onClick={handleAIInlineEdit}
                    disabled={isStreaming}
                    className="flex items-center gap-1.5 py-1 px-2.5 rounded bg-[#7c6cff15] text-[#7c6cff] border border-[#7c6cff33] text-xs font-semibold hover:bg-[#7c6cff22] transition disabled:opacity-50"
                    title="Ausgewählten Code mit der KI bearbeiten"
                  >
                    <Sparkles className="h-3 w-3" />
                    <span>KI Edit</span>
                  </button>
                  <button
                    onClick={handleAIExplainCode}
                    disabled={isStreaming}
                    className="flex items-center gap-1.5 py-1 px-2.5 rounded bg-[#ffffff05] border border-[#252a34] text-[#939aa7] text-xs font-semibold hover:text-[#e7e9ee] hover:bg-[#ffffff0a] transition disabled:opacity-50"
                  >
                    <HelpCircle className="h-3 w-3" />
                    <span>Erklären</span>
                  </button>
                </div>
              )}
            </div>

            {/* Monaco Editor Container */}
            <div className="flex-1 w-full relative">
              {activeFile ? (
                <Editor
                  height="100%"
                  language={activeFile.language}
                  value={activeFile.content}
                  theme="vs-dark"
                  onMount={(editor, monaco) => {
                    editorRef.current = editor;
                    monacoRef.current = monaco;

                    // Register Save hotkey (Ctrl + S)
                    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
                      handleSaveFile();
                    });
                  }}
                  options={{
                    fontSize: 14,
                    fontFamily: "Fira Code, Consolas, Monaco, monospace",
                    fontLigatures: true,
                    minimap: { enabled: true },
                    automaticLayout: true,
                    tabSize: 2,
                    scrollBeyondLastLine: false,
                    padding: { top: 12, bottom: 12 },
                    lineHeight: 22,
                    renderLineHighlight: "all",
                    scrollbar: {
                      vertical: "visible",
                      horizontal: "visible",
                      verticalScrollbarSize: 10,
                      horizontalScrollbarSize: 10,
                    }
                  }}
                />
              ) : (
                <div className="h-full w-full flex flex-col items-center justify-center text-center p-8 bg-[#0b0d10]">
                  <div className="h-16 w-16 rounded-full bg-[#11141a] flex items-center justify-center border border-[#252a34] mb-4">
                    <Code className="h-6 w-6 text-[#939aa7]" />
                  </div>
                  <h3 className="text-md font-semibold text-[#e7e9ee] mb-1">
                    Keine Datei geöffnet
                  </h3>
                  <p className="text-xs text-[#939aa7] max-w-xs">
                    Wähle eine Datei aus dem Explorer auf der linken Seite aus, um sie zu bearbeiten.
                  </p>
                </div>
              )}
            </div>
          </div>
        </Panel>

        {/* Split Resizer */}
        {showChat && <PanelResizeHandle className="w-1 bg-[#0b0d10] hover:bg-[#7c6cff33] active:bg-[#7c6cff] transition cursor-col-resize z-10" />}

        {/* Right Sidebar - AI Assistant Chat */}
        {showChat && (
          <Panel defaultSize="32" minSize="22" maxSize="45">
            <div className="h-full flex flex-col bg-[#11141a] border-l border-[#252a34]">

              {/* Chat Header */}
              <div className="p-3 border-b border-[#252a34] select-none">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 shrink-0">
                    <Sparkles className="h-4 w-4 text-[#7c6cff]" />
                    <span className="text-xs font-bold uppercase tracking-wider text-[#e7e9ee]">
                      AI Copilot
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={() => void loadModels({ force: true, silent: true })}
                      className="p-1 hover:bg-[#ffffff08] rounded text-[#939aa7] hover:text-[#e7e9ee] transition"
                      title="Modellliste aktualisieren"
                    >
                      <RefreshCw className={`h-3.5 w-3.5 ${modelsLoading ? "animate-spin" : ""}`} />
                    </button>
                    {chatMessages.length > 0 && (
                      <button
                        onClick={() => setChatMessages([])}
                        className="p-1 hover:bg-[#ffffff08] rounded text-[#939aa7] hover:text-red-400 transition"
                        title="Verlauf löschen"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                </div>

                {/* Primary model picker inside the chat window */}
                <div className="mt-2 flex items-center gap-2">
                  <div className="min-w-0 flex-1">{modelPicker("chat")}</div>
                  <span className="shrink-0 text-[10px] text-[#939aa7]">
                    {selectedModel?.isFree ? (
                      <span className="flex items-center gap-1 text-emerald-300">
                        <Zap className="h-3 w-3" /> kostenlos
                      </span>
                    ) : selectedModel ? (
                      <span className="font-mono">{selectedModel.contextLength ? `${Math.round(selectedModel.contextLength / 1000)}K` : ""}</span>
                    ) : null}
                  </span>
                </div>
              </div>

              {/* Chat Messages Log */}
              <div className="flex-1 overflow-y-auto p-4 space-y-4">
                {chatMessages.length === 0 ? (
                  <div className="h-full flex flex-col items-center justify-center text-center p-4">
                    <div className="h-12 w-12 rounded-xl bg-[#7c6cff1a] border border-[#7c6cff33] flex items-center justify-center mb-3">
                      <Sparkles className="h-5 w-5 text-[#7c6cff]" />
                    </div>
                    <h4 className="text-sm font-semibold text-[#e7e9ee] mb-1">
                      Wie kann ich dir helfen?
                    </h4>
                    <p className="text-xs text-[#939aa7] max-w-xs mb-3">
                      Stelle Fragen zu deinem Projekt, bitte um Code-Erklärungen oder lass dir Code generieren.
                    </p>
                    <p className="text-[10px] text-[#939aa7] max-w-xs mb-4">
                      Modell oben im Chat wählen – kostenlose Modelle laufen ohne Guthaben (nur mit Rate-Limits).
                    </p>

                    {/* Prompt Suggestions */}
                    <div className="w-full space-y-2 text-left">
                      <button
                        onClick={() => handleSendChatMessage("Erkläre mir die Funktionsweise dieses Projekts.")}
                        className="w-full text-left p-2.5 bg-[#ffffff02] border border-[#252a34] hover:border-[#7c6cff50] hover:bg-[#ffffff05] rounded-lg text-xs transition flex items-center gap-2"
                      >
                        <HelpCircle className="h-3.5 w-3.5 text-[#7c6cff]" />
                        <span>Erkläre das Projekt</span>
                      </button>
                      <button
                        onClick={() => handleSendChatMessage("Wie erstelle ich einen API-Endpunkt in Next.js?")}
                        className="w-full text-left p-2.5 bg-[#ffffff02] border border-[#252a34] hover:border-[#7c6cff50] hover:bg-[#ffffff05] rounded-lg text-xs transition flex items-center gap-2"
                      >
                        <Code className="h-3.5 w-3.5 text-[#7c6cff]" />
                        <span>Erstelle Next.js Route</span>
                      </button>
                      <button
                        onClick={() => handleSendChatMessage("Suche nach Sicherheitsrisiken oder Fehlern im aktuellen Code.")}
                        className="w-full text-left p-2.5 bg-[#ffffff02] border border-[#252a34] hover:border-[#7c6cff50] hover:bg-[#ffffff05] rounded-lg text-xs transition flex items-center gap-2"
                      >
                        <Bug className="h-3.5 w-3.5 text-[#7c6cff]" />
                        <span>Code nach Fehlern durchsuchen</span>
                      </button>
                    </div>
                  </div>
                ) : (
                  chatMessages.map((msg, idx) => {
                    const messageModel =
                      findModel(models, msg.answeredBy) ?? findModel(models, msg.modelId);
                    const hadFailover =
                      Boolean(msg.answeredBy) && Boolean(msg.modelId) && msg.answeredBy !== msg.modelId;
                    const isLast = idx === chatMessages.length - 1;
                    const isStreamingThis = isLast && isStreaming;
                    const isEmptyStreaming = isStreamingThis && !msg.content && !msg.reasoning;

                    return (
                      <div
                        key={idx}
                        className={`flex flex-col gap-1.5 ${
                          msg.role === "user" ? "items-end" : "items-start"
                        }`}
                      >
                        <span className="flex items-center gap-1.5 text-[10px] text-[#939aa7] font-semibold">
                          {msg.role === "user" ? (
                            "Du"
                          ) : (
                            <>
                              AI · {messageModel ? displayName(messageModel) : selectedModelId}
                              {messageModel?.isFree && (
                                <span className="rounded bg-emerald-400/15 px-1 py-[1px] text-[9px] text-emerald-300">
                                  FREE
                                </span>
                              )}
                              {hadFailover && (
                                <span
                                  className="rounded bg-[#7c6cff1f] px-1 py-[1px] text-[9px] text-[#a99bff]"
                                  title={`Gewählt: ${msg.modelId} · automatisch ausgewichen auf: ${msg.answeredBy}`}
                                >
                                  Failover
                                </span>
                              )}
                              {msg.aborted && <span className="text-amber-300">· gestoppt</span>}
                            </>
                          )}
                        </span>

                        <div
                          className={`p-3 rounded-xl text-xs max-w-[92%] whitespace-pre-wrap break-words leading-relaxed border ${
                            msg.role === "user"
                              ? "bg-[#7c6cff15] border-[#7c6cff40] text-[#e7e9ee]"
                              : "bg-[#0b0d10] border-[#252a34] text-[#e7e9ee]"
                          }`}
                        >
                          {msg.reasoning && msg.role === "assistant" && (
                            <ReasoningBlock reasoning={msg.reasoning} streaming={isStreamingThis} />
                          )}

                          {msg.content ||
                            (isEmptyStreaming ? (
                              <span className="flex items-center gap-2 text-[#939aa7]">
                                <Loader2 className="h-3 w-3 animate-spin text-[#7c6cff]" />
                                {streamStatus ?? "Denkt nach..."}
                              </span>
                            ) : (
                              ""
                            ))}

                          {isStreamingThis && msg.content && (
                            <span className="ml-0.5 inline-block h-3 w-1.5 animate-pulse bg-[#7c6cff] align-middle" />
                          )}

                          {msg.errorText && (
                            <div className="mt-2 rounded-lg border border-red-500/30 bg-red-500/10 p-2.5 text-[11px] leading-relaxed text-red-200">
                              <span className="flex items-start gap-1.5">
                                <CircleAlert className="mt-[1px] h-3.5 w-3.5 shrink-0" />
                                <span>{msg.errorText}</span>
                              </span>
                              <div className="mt-2 flex flex-wrap gap-2">
                                <button
                                  onClick={handleRetryLastAnswer}
                                  className="flex items-center gap-1 rounded border border-red-400/40 bg-red-400/10 px-2 py-1 text-[10px] font-semibold text-red-100 transition hover:bg-red-400/20"
                                >
                                  <RotateCcw className="h-3 w-3" /> Erneut versuchen
                                </button>
                                {msg.suggestOtherModel && (models.some((model) => model.isFree)) && (
                                  <button
                                    onClick={handleTryAnotherFreeModel}
                                    className="flex items-center gap-1 rounded border border-emerald-400/40 bg-emerald-400/10 px-2 py-1 text-[10px] font-semibold text-emerald-100 transition hover:bg-emerald-400/20"
                                  >
                                    <Zap className="h-3 w-3" /> Anderes Free-Modell
                                  </button>
                                )}
                                <button
                                  onClick={() => setChatMessages(prev => prev.filter((_, i) => i !== idx))}
                                  className="rounded border border-[#252a34] px-2 py-1 text-[10px] font-semibold text-[#939aa7] transition hover:text-[#e7e9ee]"
                                >
                                  Ausblenden
                                </button>
                              </div>
                            </div>
                          )}
                        </div>

                        {msg.role === "assistant" && msg.content && !isStreamingThis && (
                          <div className="flex items-center gap-2">
                            <button
                              onClick={() => void handleCopyMessage(msg.content)}
                              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-[#939aa7] transition hover:bg-[#ffffff08] hover:text-[#e7e9ee]"
                              title="Antwort kopieren"
                            >
                              <Copy className="h-3 w-3" /> Kopieren
                            </button>
                            <button
                              onClick={() => void handleCopyMessage(msg.content)}
                              className="hidden"
                              aria-hidden
                            />
                            <button
                              onClick={() => handleRetryLastAnswer()}
                              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-[#939aa7] transition hover:bg-[#ffffff08] hover:text-[#e7e9ee]"
                              title="Antwort neu generieren"
                            >
                              <RotateCcw className="h-3 w-3" /> Neu
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
                <div ref={chatEndRef} />
              </div>

              {/* Chat Input Field */}
              <div className="p-3 border-t border-[#252a34] bg-[#11141a]">
                {!apiKey && (
                  <button
                    onClick={() => setShowSettings(true)}
                    className="mb-2 flex w-full items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-2 text-[11px] font-semibold text-amber-200 transition hover:bg-amber-500/15"
                  >
                    <Key className="h-3.5 w-3.5" />
                    OpenRouter API-Key fehlt – jetzt eintragen
                  </button>
                )}

                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    handleSendChatMessage();
                  }}
                  className="relative flex items-center"
                >
                  <textarea
                    value={chatInput}
                    onChange={(e) => setChatInput(e.target.value)}
                    placeholder={
                      activeFile
                        ? "Frage die KI zum Code... (Dateikontext aktiv)"
                        : "Frage die KI..."
                    }
                    rows={1}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        handleSendChatMessage();
                      }
                    }}
                    className="w-full pr-10 pl-3 py-2.5 bg-[#0b0d10] border border-[#252a34] focus:border-[#7c6cff80] focus:ring-1 focus:ring-[#7c6cff80] rounded-xl text-xs resize-none placeholder-[#939aa7] text-[#e7e9ee] focus:outline-none transition"
                  />
                  {isStreaming ? (
                    <button
                      type="button"
                      onClick={handleStopStreaming}
                      className="absolute right-2 p-1.5 bg-red-500 hover:bg-red-400 text-white rounded-lg transition"
                      title="Antwort stoppen"
                    >
                      <CircleStop className="h-3.5 w-3.5" />
                    </button>
                  ) : (
                    <button
                      type="submit"
                      disabled={!chatInput.trim()}
                      className="absolute right-2 p-1.5 bg-[#7c6cff] hover:bg-[#6856ff] disabled:bg-[#252a34] disabled:text-[#939aa7] text-white rounded-lg transition"
                    >
                      <Send className="h-3.5 w-3.5" />
                    </button>
                  )}
                </form>
                <p className="text-[9px] text-[#939aa7] text-center mt-1.5">
                  Enter senden · Shift+Enter neue Zeile
                  {streamStatus ? ` · ${streamStatus}` : ""}
                </p>
              </div>
            </div>
          </Panel>
        )}

        </PanelGroup>
      </div>

      {/* Settings Modal (Overlay) */}
      {showSettings && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="w-[500px] max-h-[90vh] overflow-y-auto bg-[#11141a] border border-[#252a34] rounded-xl p-5 shadow-2xl">
            <div className="flex items-center gap-2 mb-4">
              <Settings className="h-5 w-5 text-[#7c6cff]" />
              <h3 className="font-semibold text-lg">OpenRouter-Konfiguration</h3>
            </div>

            <div className="space-y-4">
              {/* API Key */}
              <div>
                <label className="block text-xs font-semibold text-[#939aa7] mb-1.5">
                  <span className="flex items-center gap-1">
                    <Key className="h-3.5 w-3.5 text-[#7c6cff]" />
                    OpenRouter API-Key
                  </span>
                </label>
                <div className="relative">
                  <input
                    type={showApiKey ? "text" : "password"}
                    value={tempApiKey}
                    onChange={(e) => setTempApiKey(e.target.value)}
                    placeholder="sk-or-v1-..."
                    spellCheck={false}
                    autoComplete="off"
                    className="w-full px-3 py-2 pr-9 bg-[#0b0d10] border border-[#252a34] focus:border-[#7c6cff] rounded-lg text-xs font-mono text-[#e7e9ee] placeholder-[#939aa7] focus:outline-none transition"
                  />
                  <button
                    type="button"
                    onClick={() => setShowApiKey((value) => !value)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-[#939aa7] transition hover:text-[#e7e9ee]"
                    title={showApiKey ? "Key verbergen" : "Key anzeigen"}
                  >
                    {showApiKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                  </button>
                </div>
                <p className="text-[10px] text-[#939aa7] mt-1">
                  Key erstellen auf{" "}
                  <a
                    href={OPENROUTER_KEYS_URL}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[#7c6cff] hover:underline"
                  >
                    openrouter.ai/keys
                  </a>
                  {" "}· kostenlose Modelle:{" "}
                  <a
                    href={OPENROUTER_FREE_MODELS_URL}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[#7c6cff] hover:underline"
                  >
                    openrouter.ai/models?max_price=0
                  </a>
                  . Der Key bleibt lokal in diesem Gerät gespeichert.
                </p>

                <div className="mt-2 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void handleTestKey()}
                    disabled={keyChecking}
                    className="flex items-center gap-1.5 rounded-lg border border-[#7c6cff50] bg-[#7c6cff15] px-2.5 py-1.5 text-[11px] font-semibold text-[#a99bff] transition hover:bg-[#7c6cff25] disabled:opacity-50"
                  >
                    {keyChecking ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <ShieldCheck className="h-3.5 w-3.5" />
                    )}
                    Verbindung testen
                  </button>
                  {keyInfo && (
                    <span className="flex items-center gap-1 text-[10px] text-emerald-300">
                      <Wallet className="h-3 w-3" />
                      {typeof keyInfo.limit_remaining === "number"
                        ? `Guthaben: $${keyInfo.limit_remaining.toFixed(2)}`
                        : keyInfo.is_free_tier
                          ? "Free-Tier aktiv"
                          : "Key gültig"}
                    </span>
                  )}
                </div>
              </div>

              {/* Base URL */}
              <div>
                <label className="block text-xs font-semibold text-[#939aa7] mb-1.5">
                  <span className="flex items-center gap-1">
                    <Globe className="h-3.5 w-3.5 text-[#7c6cff]" />
                    API-Endpunkt (Base URL)
                  </span>
                </label>
                <select
                  value={
                    OPENROUTER_BASE_URLS.includes(tempBaseUrl as any) ? tempBaseUrl : "custom"
                  }
                  onChange={(e) => setTempBaseUrl(e.target.value)}
                  className="w-full px-3 py-2 bg-[#0b0d10] border border-[#252a34] focus:border-[#7c6cff] rounded-lg text-xs text-[#e7e9ee] focus:outline-none transition"
                >
                  {OPENROUTER_BASE_URLS.map((url) => (
                    <option key={url} value={url}>
                      {url}
                    </option>
                  ))}
                  <option value="custom">Benutzerdefiniert…</option>
                </select>
                {!OPENROUTER_BASE_URLS.includes(tempBaseUrl as any) && (
                  <input
                    type="text"
                    value={tempBaseUrl === "custom" ? "" : tempBaseUrl}
                    onChange={(e) => setTempBaseUrl(e.target.value)}
                    placeholder="https://openrouter.ai/api/v1"
                    className="w-full mt-2 px-3 py-2 bg-[#0b0d10] border border-[#252a34] focus:border-[#7c6cff] rounded-lg text-xs text-[#e7e9ee] placeholder-[#939aa7] focus:outline-none transition"
                  />
                )}
              </div>

              {/* Info */}
              <div className="rounded-lg border border-[#252a34] bg-[#0b0d10] p-3 text-[10px] leading-relaxed text-[#939aa7]">
                <span className="font-semibold text-[#e7e9ee]">So funktioniert&apos;s:</span>
                <ul className="mt-1 list-disc space-y-0.5 pl-4">
                  <li>Modelle werden live von OpenRouter geladen und im Chatfenster gewählt.</li>
                  <li>
                    Modelle mit <span className="text-emerald-300">Free</span>-Badge kosten nichts,
                    sind aber stark limitiert (Rate-Limits, Wartezeiten).
                  </li>
                  <li>
                    Als Start ist ein zuverlässiges Gratis-Modell vorausgewählt; kostenlose
                    Modelle erkennst du am <span className="text-emerald-300">Free</span>-Badge.
                  </li>
                  <li>Rate-Limits und Serverfehler werden automatisch 2× mit Wartezeit wiederholt.</li>
                  <li>
                    Fällt ein Gratis-Modell aus, antwortet automatisch ein anderes Free-Modell
                    (angezeigt unter der Antwort).
                  </li>
                </ul>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 mt-6">
              <button
                onClick={() => setShowSettings(false)}
                className="px-4 py-2 hover:bg-[#ffffff05] rounded-lg text-xs font-semibold text-[#939aa7] hover:text-[#e7e9ee] transition"
              >
                Abbrechen
              </button>
              <button
                onClick={handleSaveSettings}
                className="px-4 py-2 bg-[#7c6cff] hover:bg-[#6856ff] text-white rounded-lg text-xs font-semibold transition"
              >
                Speichern
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 *  Reasoning block for thinking models
 * ------------------------------------------------------------------ */
function ReasoningBlock({ reasoning, streaming }: { reasoning: string; streaming: boolean }) {
  const [open, setOpen] = useState(false);
  const expanded = open || streaming;

  return (
    <div className="mb-2 rounded-lg border border-[#252a34] bg-[#ffffff03] p-2">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-1.5 text-[10px] font-semibold text-[#939aa7] transition hover:text-[#e7e9ee]"
      >
        <Brain className="h-3 w-3 text-[#7c6cff]" />
        Denkprozess {streaming ? "(läuft)" : ""}
        <ChevronDown className={`h-3 w-3 transition ${expanded ? "rotate-180" : ""}`} />
      </button>
      {expanded && (
        <pre className="mt-1.5 max-h-40 overflow-y-auto whitespace-pre-wrap break-words font-mono text-[10px] leading-relaxed text-[#939aa7]">
          {reasoning}
        </pre>
      )}
    </div>
  );
}

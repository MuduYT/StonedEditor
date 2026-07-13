"use client";

import React, { useState, useEffect, useRef } from "react";
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
  Play,
  Key,
  Globe,
  Loader2,
  Code,
  Bug,
  HelpCircle,
  FileCode,
  Cpu,
  Trash2,
  FolderOpen,
  Save,
  PanelRightClose,
  PanelRightOpen,
  RefreshCw,
} from "lucide-react";
import {
  Panel,
  Group as PanelGroup,
  Separator as PanelResizeHandle,
} from "react-resizable-panels";
import { Toaster, toast } from "sonner";
import {
  streamChatCompletion,
  streamCompletionIntoMonaco,
  FREEMODEL_MODELS,
  FREEMODEL_BASE_URLS,
  DEFAULT_FREEMODEL_BASE_URL,
  createFileAwareMessages,
  ChatMessage,
  FreeModelName,
  FileContext,
} from "../../lib/ai/api";

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

interface FileItem {
  name: string;
  path: string;
  content: string;
  language: string;
  isFolder: boolean;
  children?: FileItem[];
}

export function AppShell() {
  // Config & Settings
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState(DEFAULT_FREEMODEL_BASE_URL);
  const [selectedModel, setSelectedModel] = useState<FreeModelName>("gpt-5.5");
  const [showSettings, setShowSettings] = useState(false);
  const [tempApiKey, setTempApiKey] = useState("");
  const [tempBaseUrl, setTempBaseUrl] = useState("");

  // UI Panels
  const [showChat, setShowChat] = useState(true);
  const [mounted, setMounted] = useState(false);

  // VFS & Files
  const [files, setFiles] = useState<FileItem[]>([]);
  const [activeFile, setActiveFile] = useState<FileItem | null>(null);
  const [expandedFolders, setExpandedFolders] = useState<Record<string, boolean>>({});
  const [openedFolderRoot, setOpenedFolderRoot] = useState<string | null>(null);

  // Chat
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);

  // Monaco Editor Ref
  const editorRef = useRef<MonacoEditorType.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<Monaco | null>(null);

  // Load API key from local storage on mount
  useEffect(() => {
    const savedKey = localStorage.getItem("freemodel_api_key") || "";
    const savedUrl = localStorage.getItem("freemodel_base_url") || DEFAULT_FREEMODEL_BASE_URL;
    const savedModel = localStorage.getItem("freemodel_model") || "gpt-5.5";
    
    setApiKey(savedKey);
    setBaseUrl(savedUrl);
    setSelectedModel(savedModel as FreeModelName);
    
    setTempApiKey(savedKey);
    setTempBaseUrl(savedUrl);

    if (!savedKey) {
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

  const handleSaveSettings = () => {
    localStorage.setItem("freemodel_api_key", tempApiKey);
    localStorage.setItem("freemodel_base_url", tempBaseUrl);
    setApiKey(tempApiKey);
    setBaseUrl(tempBaseUrl);
    setShowSettings(false);
    toast.success("Einstellungen gespeichert!");
  };

  const handleModelChange = (model: FreeModelName) => {
    setSelectedModel(model);
    localStorage.setItem("freemodel_model", model);
    toast.success(`Modell auf ${model} gewechselt`);
  };

  // Toggle Folder Expansion
  const toggleFolder = (path: string) => {
    setExpandedFolders(prev => ({
      ...prev,
      [path]: !prev[path]
    }));
  };

  // Select active file
  const selectFile = (file: FileItem) => {
    if (file.isFolder) return;
    setActiveFile(file);
  };

  // Handle local file save
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

  // Open real directory in Tauri
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

      // In a real desktop app, we would recursively scan directories. 
      // For safety and simple integration, we'll create a list of main files from the selected path.
      // We will search for common files or load the StonedEditor folder files.
      // Since scanning files recursively in frontend via Tauri FS requires recursive calls, let's build a quick structure.
      // Let's load the main project files since we are inside StonedEditor's folder itself!
      // The current folder is selected. We can scan it.
      // Let's execute a helper via rust or read standard files:
      // For now, let's load the files of the current workspace:
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

  // AI Chat streaming logic
  const handleSendChatMessage = async (overridePrompt?: string) => {
    const promptToSend = overridePrompt || chatInput;
    if (!promptToSend.trim()) return;

    if (!apiKey) {
      toast.error("Bitte gib zuerst einen FreeModel.dev API-Key in den Einstellungen ein.");
      setShowSettings(true);
      return;
    }

    const newUserMessage: ChatMessage = {
      role: "user",
      content: promptToSend
    };

    setChatMessages(prev => [...prev, newUserMessage]);
    if (!overridePrompt) setChatInput("");
    setIsStreaming(true);

    const assistantMessagePlaceholder: ChatMessage = {
      role: "assistant",
      content: ""
    };
    setChatMessages(prev => [...prev, assistantMessagePlaceholder]);

    // Build file context for AI awareness
    let fileContext: FileContext = { content: "" };
    if (activeFile) {
      fileContext = {
        path: activeFile.path,
        language: activeFile.language,
        content: editorRef.current?.getValue() || activeFile.content,
        selection: editorRef.current?.getModel()?.getValueInRange(editorRef.current.getSelection()!) || ""
      };
    }

    // Combine previous messages + dynamic file context
    const fileAwareMessages = createFileAwareMessages(promptToSend, fileContext);
    
    // For conversation history, we pass the full list.
    // To keep it simple & file-aware, let's inject the file awareness in the last request.
    const finalMessages = [
      ...chatMessages.filter(m => m.role !== "system"),
      ...fileAwareMessages
    ];

    try {
      let accumulatedText = "";
      await streamChatCompletion({
        apiKey,
        baseUrl,
        model: selectedModel,
        messages: finalMessages,
        onTextDelta(delta) {
          accumulatedText += delta;
          setChatMessages(prev => {
            const updated = [...prev];
            if (updated.length > 0) {
              updated[updated.length - 1] = {
                role: "assistant",
                content: accumulatedText
              };
            }
            return updated;
          });
        }
      });
    } catch (err: any) {
      toast.error(`Streaming-Fehler: ${err.message || err}`);
      setChatMessages(prev => {
        const updated = [...prev];
        if (updated.length > 0) {
          updated[updated.length - 1] = {
            role: "assistant",
            content: `❌ Fehler beim Generieren der Antwort:\n${err.message || err}`
          };
        }
        return updated;
      });
    } finally {
      setIsStreaming(false);
    }
  };

  // AI Code Completion stream directly into Monaco Editor
  const handleAIInlineEdit = async () => {
    if (!editorRef.current || !activeFile) return;

    if (!apiKey) {
      toast.error("Bitte gib zuerst einen FreeModel.dev API-Key in den Einstellungen ein.");
      setShowSettings(true);
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

    setIsStreaming(true);
    toast.info("KI generiert Code-Änderungen inline...");

    const fileContext = {
      path: activeFile.path,
      language: activeFile.language,
      content: editorRef.current.getValue(),
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
        model: selectedModel,
        messages,
        keepCursorAtEnd: true
      });
      toast.success("Code erfolgreich inline eingefügt!");
    } catch (err: any) {
      toast.error(`Fehler bei Inline-Generierung: ${err.message || err}`);
    } finally {
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

    handleSendChatMessage(`Erkläre mir diesen Codebereich:\n\n\`\`\`${activeFile?.language || "javascript"}\n${selectedText}\n\`\`\``);
  };

  // Render File Tree Nodes
  const renderFileTree = (items: FileItem[], depth = 0) => {
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
              AI Powered
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
          <div className="flex items-center gap-1.5 bg-[#ffffff05] border border-[#252a34] rounded-lg px-2 py-1">
            <Cpu className="h-3.5 w-3.5 text-[#7c6cff]" />
            <select
              value={selectedModel}
              onChange={(e) => handleModelChange(e.target.value as FreeModelName)}
              className="bg-transparent text-xs font-semibold focus:outline-none cursor-pointer text-[#e7e9ee]"
            >
              {FREEMODEL_MODELS.map((model) => (
                <option key={model} value={model} className="bg-[#11141a]">
                  {model}
                </option>
              ))}
            </select>
          </div>

          {/* Settings Trigger */}
          <button
            onClick={() => {
              setTempApiKey(apiKey);
              setTempBaseUrl(baseUrl);
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
                  <Key className="h-3 w-3 text-[#7c6cff]" />
                  API-Key: {apiKey ? "Eingerichtet" : "Fehlt"}
                </span>
                {!apiKey && (
                  <button
                    onClick={() => setShowSettings(true)}
                    className="text-[#7c6cff] font-semibold hover:underline"
                  >
                    Einrichten
                  </button>
                )}
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
            <Panel defaultSize="30" minSize="20" maxSize="45">
              <div className="h-full flex flex-col bg-[#11141a] border-l border-[#252a34]">
                
                {/* Chat Header */}
                <div className="p-3.5 border-b border-[#252a34] flex items-center justify-between select-none">
                  <div className="flex items-center gap-2">
                    <Sparkles className="h-4 w-4 text-[#7c6cff]" />
                    <span className="text-xs font-bold uppercase tracking-wider text-[#e7e9ee]">
                      AI Copilot
                    </span>
                  </div>
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
                      <p className="text-xs text-[#939aa7] max-w-xs mb-4">
                        Stelle Fragen zu deinem Projekt, bitte um Code-Erklärungen oder lass dir Code generieren.
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
                    chatMessages.map((msg, idx) => (
                      <div
                        key={idx}
                        className={`flex flex-col gap-1.5 ${
                          msg.role === "user" ? "items-end" : "items-start"
                        }`}
                      >
                        <span className="text-[10px] text-[#939aa7] font-semibold">
                          {msg.role === "user" ? "Du" : `AI (${selectedModel})`}
                        </span>
                        <div
                          className={`p-3 rounded-xl text-xs max-w-[90%] whitespace-pre-wrap break-words leading-relaxed border ${
                            msg.role === "user"
                              ? "bg-[#7c6cff15] border-[#7c6cff40] text-[#e7e9ee]"
                              : "bg-[#0b0d10] border-[#252a34] text-[#e7e9ee]"
                          }`}
                        >
                          {msg.content || (
                            <span className="flex items-center gap-2 text-[#939aa7]">
                              <Loader2 className="h-3 w-3 animate-spin text-[#7c6cff]" />
                              Denkt nach...
                            </span>
                          )}
                        </div>
                      </div>
                    ))
                  )}
                </div>

                {/* Chat Input Field */}
                <div className="p-3 border-t border-[#252a34] bg-[#11141a]">
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
                    <button
                      type="submit"
                      disabled={isStreaming || !chatInput.trim()}
                      className="absolute right-2 p-1.5 bg-[#7c6cff] hover:bg-[#6856ff] disabled:bg-[#252a34] disabled:text-[#939aa7] text-white rounded-lg transition"
                    >
                      {isStreaming ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Send className="h-3.5 w-3.5" />
                      )}
                    </button>
                  </form>
                  <p className="text-[9px] text-[#939aa7] text-center mt-1.5">
                    Drücke Enter zum Senden. Shift+Enter für eine neue Zeile.
                  </p>
                </div>
              </div>
            </Panel>
          )}

        </PanelGroup>
      </div>

      {/* Settings Modal (Overlay) */}
      {showSettings && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="w-[450px] bg-[#11141a] border border-[#252a34] rounded-xl p-5 shadow-2xl animate-in fade-in zoom-in duration-200">
            <div className="flex items-center gap-2 mb-4">
              <Settings className="h-5 w-5 text-[#7c6cff]" />
              <h3 className="font-semibold text-lg">AI-Konfiguration</h3>
            </div>
            
            <div className="space-y-4">
              {/* API Key */}
              <div>
                <label className="block text-xs font-semibold text-[#939aa7] mb-1.5 flex items-center gap-1">
                  <Key className="h-3.5 w-3.5 text-[#7c6cff]" />
                  FreeModel.dev API-Key
                </label>
                <input
                  type="password"
                  value={tempApiKey}
                  onChange={(e) => setTempApiKey(e.target.value)}
                  placeholder="Geben Sie Ihren API-Key ein"
                  className="w-full px-3 py-2 bg-[#0b0d10] border border-[#252a34] focus:border-[#7c6cff] rounded-lg text-xs text-[#e7e9ee] placeholder-[#939aa7] focus:outline-none transition"
                />
                <p className="text-[10px] text-[#939aa7] mt-1">
                  Du erhältst einen kostenlosen API-Key auf{" "}
                  <a
                    href="https://freemodel.dev"
                    target="_blank"
                    rel="noreferrer"
                    className="text-[#7c6cff] hover:underline"
                  >
                    FreeModel.dev
                  </a>
                  .
                </p>
              </div>

              {/* Base URL */}
              <div>
                <label className="block text-xs font-semibold text-[#939aa7] mb-1.5 flex items-center gap-1">
                  <Globe className="h-3.5 w-3.5 text-[#7c6cff]" />
                  API Endpoint Base URL
                </label>
                <select
                  value={tempBaseUrl}
                  onChange={(e) => setTempBaseUrl(e.target.value)}
                  className="w-full px-3 py-2 bg-[#0b0d10] border border-[#252a34] focus:border-[#7c6cff] rounded-lg text-xs text-[#e7e9ee] focus:outline-none transition"
                >
                  {FREEMODEL_BASE_URLS.map((url) => (
                    <option key={url} value={url}>
                      {url}
                    </option>
                  ))}
                  <option value={tempBaseUrl !== DEFAULT_FREEMODEL_BASE_URL && !FREEMODEL_BASE_URLS.includes(tempBaseUrl as any) ? tempBaseUrl : "custom"}>
                    Benutzerdefiniert...
                  </option>
                </select>
                {/* Custom Base URL Input if selected */}
                {!FREEMODEL_BASE_URLS.includes(tempBaseUrl as any) && (
                  <input
                    type="text"
                    value={tempBaseUrl === "custom" ? "" : tempBaseUrl}
                    onChange={(e) => setTempBaseUrl(e.target.value)}
                    placeholder="https://your-custom-endpoint.com/v1"
                    className="w-full mt-2 px-3 py-2 bg-[#0b0d10] border border-[#252a34] focus:border-[#7c6cff] rounded-lg text-xs text-[#e7e9ee] placeholder-[#939aa7] focus:outline-none transition"
                  />
                )}
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 mt-6">
              {apiKey && (
                <button
                  onClick={() => setShowSettings(false)}
                  className="px-4 py-2 hover:bg-[#ffffff05] rounded-lg text-xs font-semibold text-[#939aa7] hover:text-[#e7e9ee] transition"
                >
                  Abbrechen
                </button>
              )}
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

"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUpDown,
  Brain,
  Check,
  ChevronDown,
  Image as ImageIcon,
  Loader2,
  RefreshCw,
  Search,
  Star,
  Wrench,
  X,
  Zap,
} from "lucide-react";
import {
  EMPTY_FILTERS,
  displayName,
  filterModels,
  formatContextLength,
  formatPrice,
  listProviders,
  modalityLabel,
  type AiModel,
  type CatalogSource,
  type ModelFilterState,
  type ModelSort,
} from "../../lib/ai/models";

export interface ModelPickerProps {
  models: AiModel[];
  loading: boolean;
  source: CatalogSource;
  catalogError?: string | null;
  selectedModelId: string;
  favorites: string[];
  onSelect: (modelId: string) => void;
  onToggleFavorite: (modelId: string) => void;
  onReload: () => void;
  /** "chat" is the primary picker inside the chat panel, "compact" for the header. */
  variant?: "chat" | "compact";
}

const RESULT_PAGE = 60;

const SORT_OPTIONS: Array<{ value: ModelSort; label: string }> = [
  { value: "recommended", label: "Empfohlen" },
  { value: "name", label: "Name (A–Z)" },
  { value: "context", label: "Größter Kontext" },
  { value: "newest", label: "Neueste" },
  { value: "cheapest", label: "Günstigste" },
];

const MODALITY_OPTIONS: Array<{ value: ModelFilterState["modality"]; label: string }> = [
  { value: "any", label: "Alle Eingaben" },
  { value: "image", label: "Bilder" },
  { value: "file", label: "Dateien" },
  { value: "audio", label: "Audio" },
  { value: "video", label: "Video" },
];

export function ModelPicker({
  models,
  loading,
  source,
  catalogError,
  selectedModelId,
  favorites,
  onSelect,
  onToggleFavorite,
  onReload,
  variant = "chat",
}: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  const [filters, setFilters] = useState<ModelFilterState>(EMPTY_FILTERS);
  const [visibleCount, setVisibleCount] = useState(RESULT_PAGE);
  const [activeIndex, setActiveIndex] = useState(0);
  const [position, setPosition] = useState<{ top: number; left: number; width: number } | null>(null);

  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  const selectedModel = useMemo(
    () => models.find((model) => model.id === selectedModelId),
    [models, selectedModelId],
  );

  const results = useMemo(() => filterModels(models, filters), [models, filters]);

  const favoriteModels = useMemo(() => {
    if (filters.sort !== "recommended" || filters.query.trim()) {
      return [];
    }

    const favoriteIds = new Set(favorites);

    return results.filter((model) => favoriteIds.has(model.id));
  }, [favorites, filters.query, filters.sort, results]);

  const otherModels = useMemo(() => {
    const favoriteIds = new Set(favoriteModels.map((model) => model.id));

    return results.filter((model) => !favoriteIds.has(model.id));
  }, [favoriteModels, results]);

  const flatList = useMemo(
    () => [...favoriteModels, ...otherModels],
    [favoriteModels, otherModels],
  );

  const visibleModels = useMemo(
    () => flatList.slice(0, visibleCount),
    [flatList, visibleCount],
  );

  const freeCount = useMemo(() => models.filter((model) => model.isFree).length, [models]);
  const providers = useMemo(() => listProviders(models), [models]);

  /* ---------------------------------------------------------------- */
  /* Positioning: fixed panel so it is never clipped by the panels.    */
  /* ---------------------------------------------------------------- */
  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;

    if (!trigger) {
      return;
    }

    const rect = trigger.getBoundingClientRect();
    const width = Math.min(variant === "chat" ? 440 : 420, window.innerWidth - 24);
    const left = Math.min(
      Math.max(12, rect.right - width),
      Math.max(12, window.innerWidth - width - 12),
    );

    setPosition({ top: rect.bottom + 8, left, width });
  }, [variant]);

  useEffect(() => {
    if (!open) {
      return;
    }

    updatePosition();
    setVisibleCount(RESULT_PAGE);
    setActiveIndex(0);

    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;

      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) {
        return;
      }

      setOpen(false);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };

    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", updatePosition);

    const focusTimer = window.setTimeout(() => searchRef.current?.focus(), 30);

    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", updatePosition);
      window.clearTimeout(focusTimer);
    };
  }, [open, updatePosition]);

  useEffect(() => {
    setVisibleCount(RESULT_PAGE);
    setActiveIndex(0);
  }, [filters]);

  useEffect(() => {
    const active = panelRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`);
    active?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, visibleModels.length]);

  const choose = (modelId: string) => {
    onSelect(modelId);
    setOpen(false);
  };

  const handlePanelKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => {
        const next = Math.min(index + 1, flatList.length - 1);

        if (next >= visibleCount) {
          setVisibleCount((count) => count + RESULT_PAGE);
        }

        return next;
      });
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => Math.max(0, index - 1));
    } else if (event.key === "Enter") {
      const model = flatList[activeIndex];

      if (model) {
        event.preventDefault();
        choose(model.id);
      }
    }
  };

  const sourceLabel =
    source === "live"
      ? `live geladen`
      : source === "cache"
        ? "aus dem Offline-Cache"
        : "Notliste (offline)";

  const isCompact = variant === "compact";

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Modell auswählen"
        className={`group flex items-center gap-2 rounded-lg border transition ${
          isCompact ? "px-2 py-1 text-[11px]" : "px-2.5 py-1.5 text-xs"
        } ${
          open
            ? "border-[#7c6cff80] bg-[#7c6cff1f] text-[#e7e9ee]"
            : "border-[#252a34] bg-[#ffffff05] text-[#e7e9ee] hover:border-[#7c6cff50] hover:bg-[#ffffff0a]"
        }`}
      >
        {loading ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-[#7c6cff]" />
        ) : (
          <span
            className={`h-2 w-2 shrink-0 rounded-full ${
              selectedModel?.isFree ? "bg-emerald-400" : "bg-[#7c6cff]"
            }`}
          />
        )}

        {selectedModel ? (
          <span className={`flex items-center gap-1.5 truncate ${isCompact ? "max-w-[11rem]" : "max-w-[13rem]"}`}>
            <span className="truncate font-semibold">
              {displayName(selectedModel)}
            </span>
            {selectedModel.isFree && (
              <span className="rounded bg-emerald-400/15 px-1 py-[1px] text-[9px] font-bold uppercase tracking-wide text-emerald-300">
                Free
              </span>
            )}
          </span>
        ) : (
          <span className="truncate font-semibold text-[#939aa7]">
            {loading ? "Modelle laden…" : "Modell wählen"}
          </span>
        )}

        <ChevronDown
          className={`h-3.5 w-3.5 shrink-0 text-[#939aa7] transition ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && position && (
        <div
          ref={panelRef}
          role="dialog"
          aria-label="Modell auswählen"
          onKeyDown={handlePanelKeyDown}
          style={{ top: position.top, left: position.left, width: position.width }}
          className="fixed z-[60] flex max-h-[min(34rem,calc(100vh-6rem))] flex-col overflow-hidden rounded-xl border border-[#252a34] bg-[#141822] shadow-2xl shadow-black/50"
        >
          {/* Search */}
          <div className="border-b border-[#252a34] p-2.5">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#939aa7]" />
              <input
                ref={searchRef}
                value={filters.query}
                onChange={(event) =>
                  setFilters((prev) => ({ ...prev, query: event.target.value }))
                }
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    setOpen(false);
                  }
                }}
                placeholder="Modell, Anbieter oder ID suchen…"
                className="w-full rounded-lg border border-[#252a34] bg-[#0b0d10] py-2 pl-8 pr-8 text-xs text-[#e7e9ee] placeholder-[#939aa7] outline-none transition focus:border-[#7c6cff80]"
              />
              {filters.query && (
                <button
                  type="button"
                  onClick={() => setFilters((prev) => ({ ...prev, query: "" }))}
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-[#939aa7] transition hover:text-[#e7e9ee]"
                  title="Suche leeren"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>

            {/* Quick filters */}
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <FilterChip
                active={filters.freeOnly}
                onClick={() => setFilters((prev) => ({ ...prev, freeOnly: !prev.freeOnly }))}
                icon={<Zap className="h-3 w-3" />}
                label={`Kostenlos${freeCount ? ` (${freeCount})` : ""}`}
                tone="emerald"
              />
              <FilterChip
                active={filters.toolsOnly}
                onClick={() => setFilters((prev) => ({ ...prev, toolsOnly: !prev.toolsOnly }))}
                icon={<Wrench className="h-3 w-3" />}
                label="Werkzeuge"
              />
              <FilterChip
                active={filters.reasoningOnly}
                onClick={() =>
                  setFilters((prev) => ({ ...prev, reasoningOnly: !prev.reasoningOnly }))
                }
                icon={<Brain className="h-3 w-3" />}
                label="Denkt nach"
              />
              <FilterChip
                active={filters.modality !== "any"}
                onClick={() =>
                  setFilters((prev) => ({
                    ...prev,
                    modality: prev.modality === "any" ? "image" : "any",
                  }))
                }
                icon={<ImageIcon className="h-3 w-3" />}
                label="Bilder"
              />
            </div>

            {/* Selects */}
            <div className="mt-2 grid grid-cols-2 gap-1.5">
              <select
                value={filters.provider ?? ""}
                onChange={(event) =>
                  setFilters((prev) => ({ ...prev, provider: event.target.value || null }))
                }
                className="w-full rounded-lg border border-[#252a34] bg-[#0b0d10] px-2 py-1.5 text-[11px] text-[#e7e9ee] outline-none transition focus:border-[#7c6cff80]"
                title="Anbieter filtern"
              >
                <option value="">Alle Anbieter ({providers.length})</option>
                {providers.map((entry) => (
                  <option key={entry.provider} value={entry.provider}>
                    {entry.label} ({entry.count})
                  </option>
                ))}
              </select>

              <select
                value={filters.sort}
                onChange={(event) =>
                  setFilters((prev) => ({ ...prev, sort: event.target.value as ModelSort }))
                }
                className="w-full rounded-lg border border-[#252a34] bg-[#0b0d10] px-2 py-1.5 text-[11px] text-[#e7e9ee] outline-none transition focus:border-[#7c6cff80]"
                title="Sortierung"
              >
                {SORT_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>

            {filters.modality !== "any" && (
              <select
                value={filters.modality}
                onChange={(event) =>
                  setFilters((prev) => ({
                    ...prev,
                    modality: event.target.value as ModelFilterState["modality"],
                  }))
                }
                className="mt-1.5 w-full rounded-lg border border-[#252a34] bg-[#0b0d10] px-2 py-1.5 text-[11px] text-[#e7e9ee] outline-none transition focus:border-[#7c6cff80]"
              >
                {MODALITY_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    Eingabe: {option.label}
                  </option>
                ))}
              </select>
            )}

            <div className="mt-2 flex items-center justify-between text-[10px] text-[#939aa7]">
              <span>
                {results.length} von {models.length} Modellen · {sourceLabel}
              </span>
              <div className="flex items-center gap-2">
                {(filters.query ||
                  filters.freeOnly ||
                  filters.provider ||
                  filters.modality !== "any" ||
                  filters.toolsOnly ||
                  filters.reasoningOnly) && (
                  <button
                    type="button"
                    onClick={() => setFilters({ ...EMPTY_FILTERS, sort: filters.sort })}
                    className="font-semibold text-[#7c6cff] hover:underline"
                  >
                    Filter zurücksetzen
                  </button>
                )}
                <button
                  type="button"
                  onClick={onReload}
                  className="flex items-center gap-1 font-semibold text-[#7c6cff] hover:underline"
                  title="Modellliste neu laden"
                >
                  {loading ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <RefreshCw className="h-3 w-3" />
                  )}
                  Neu laden
                </button>
              </div>
            </div>
          </div>

          {/* Results */}
          <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
            {catalogError && source !== "live" && (
              <div className="mb-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-2 text-[10px] leading-relaxed text-amber-200">
                {source === "fallback"
                  ? "OpenRouter war nicht erreichbar – es wird eine Notliste angezeigt. Prüfe deine Internetverbindung."
                  : "OpenRouter war nicht erreichbar – die zuletzt geladene Liste wird verwendet."}
              </div>
            )}

            {results.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-2 p-6 text-center">
                <Search className="h-5 w-5 text-[#252a34]" />
                <span className="text-xs text-[#939aa7]">
                  Kein Modell passt zu deinen Filtern.
                </span>
              </div>
            ) : (
              <>
                {favoriteModels.length > 0 && (
                  <div className="px-1.5 pb-1 pt-1 text-[9px] font-bold uppercase tracking-wider text-[#939aa7]">
                    Favoriten
                  </div>
                )}

                {visibleModels.map((model, index) => {
                  const isActive = index === activeIndex;
                  const isSelected = model.id === selectedModelId;
                  const isFavorite = favorites.includes(model.id);

                  if (index === favoriteModels.length && favoriteModels.length > 0) {
                    return (
                      <React.Fragment key="all-models">
                        <div className="px-1.5 pb-1 pt-2 text-[9px] font-bold uppercase tracking-wider text-[#939aa7]">
                          Alle Modelle
                        </div>
                        <ModelRow
                          model={model}
                          index={index}
                          isActive={isActive}
                          isSelected={isSelected}
                          isFavorite={isFavorite}
                          onChoose={choose}
                          onToggleFavorite={onToggleFavorite}
                          onHover={setActiveIndex}
                        />
                      </React.Fragment>
                    );
                  }

                  return (
                    <ModelRow
                      key={model.id}
                      model={model}
                      index={index}
                      isActive={isActive}
                      isSelected={isSelected}
                      isFavorite={isFavorite}
                      onChoose={choose}
                      onToggleFavorite={onToggleFavorite}
                      onHover={setActiveIndex}
                    />
                  );
                })}

                {flatList.length > visibleModels.length && (
                  <button
                    type="button"
                    onClick={() => setVisibleCount((count) => count + RESULT_PAGE)}
                    className="mt-1 w-full rounded-lg border border-[#252a34] bg-[#ffffff05] py-2 text-[11px] font-semibold text-[#939aa7] transition hover:border-[#7c6cff50] hover:text-[#e7e9ee]"
                  >
                    {flatList.length - visibleModels.length} weitere anzeigen
                  </button>
                )}
              </>
            )}
          </div>

          <div className="flex items-center justify-between border-t border-[#252a34] px-2.5 py-1.5 text-[10px] text-[#939aa7]">
            <span className="flex items-center gap-1.5">
              <ArrowUpDown className="h-3 w-3" />
              ↑ ↓ navigieren · Enter wählen · Esc schließen
            </span>
            <span>{modalityLabel("text")}-Chat</span>
          </div>
        </div>
      )}
    </>
  );
}

interface ModelRowProps {
  model: AiModel;
  index: number;
  isActive: boolean;
  isSelected: boolean;
  isFavorite: boolean;
  onChoose: (modelId: string) => void;
  onToggleFavorite: (modelId: string) => void;
  onHover: (index: number) => void;
}

function ModelRow({
  model,
  index,
  isActive,
  isSelected,
  isFavorite,
  onChoose,
  onToggleFavorite,
  onHover,
}: ModelRowProps) {
  return (
    <div
      data-index={index}
      onMouseEnter={() => onHover(index)}
      className={`group flex w-full items-start gap-2 rounded-lg px-2 py-2 transition ${
        isActive ? "bg-[#ffffff0a]" : ""
      } ${isSelected ? "border border-[#7c6cff50] bg-[#7c6cff14]" : "border border-transparent"}`}
    >
      <button
        type="button"
        onClick={() => onChoose(model.id)}
        className="min-w-0 flex-1 text-left"
        title={model.id}
      >
        <div className="flex items-center gap-1.5">
          <span className="truncate text-xs font-semibold text-[#e7e9ee]">
            {displayName(model)}
          </span>
          {model.isFree ? (
            <span className="shrink-0 rounded bg-emerald-400/15 px-1 py-[1px] text-[9px] font-bold uppercase tracking-wide text-emerald-300">
              Free
            </span>
          ) : (
            <span className="shrink-0 rounded bg-[#7c6cff1f] px-1 py-[1px] text-[9px] font-bold uppercase tracking-wide text-[#a99bff]">
              {model.providerLabel}
            </span>
          )}
          {isSelected && <Check className="h-3 w-3 shrink-0 text-[#7c6cff]" />}
        </div>

        <div className="mt-0.5 flex items-center gap-2 text-[10px] text-[#939aa7]">
          <span className="truncate font-mono">{model.id}</span>
        </div>

        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-[#939aa7]">
          <span>{formatContextLength(model.contextLength)}</span>
          <span className="text-[#252a34]">•</span>
          <span className={model.isFree ? "text-emerald-300" : ""}>{formatPrice(model)}</span>
          {model.supportsTools && (
            <span className="flex items-center gap-0.5" title="Unterstützt Werkzeuge/Funktionsaufrufe">
              <Wrench className="h-2.5 w-2.5" /> Tools
            </span>
          )}
          {model.supportsReasoning && (
            <span className="flex items-center gap-0.5" title="Denkt nach (Reasoning)">
              <Brain className="h-2.5 w-2.5" /> Reasoning
            </span>
          )}
          {model.inputModalities.includes("image") && (
            <span className="flex items-center gap-0.5" title="Kann Bilder lesen">
              <ImageIcon className="h-2.5 w-2.5" /> Bilder
            </span>
          )}
          {model.expirationDate && (
            <span className="text-amber-300" title={`Läuft ab am ${model.expirationDate}`}>
              läuft ab {model.expirationDate}
            </span>
          )}
        </div>
      </button>

      <button
        type="button"
        onClick={() => onToggleFavorite(model.id)}
        title={isFavorite ? "Aus Favoriten entfernen" : "Zu Favoriten hinzufügen"}
        className={`mt-0.5 rounded p-1 transition ${
          isFavorite
            ? "text-amber-300"
            : "text-[#3a4150] opacity-0 hover:text-amber-300 group-hover:opacity-100"
        }`}
      >
        <Star className={`h-3.5 w-3.5 ${isFavorite ? "fill-amber-300" : ""}`} />
      </button>
    </div>
  );
}

interface FilterChipProps {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  tone?: "emerald" | "default";
}

function FilterChip({ active, onClick, icon, label, tone = "default" }: FilterChipProps) {
  const activeClasses =
    tone === "emerald"
      ? "border-emerald-400/40 bg-emerald-400/15 text-emerald-300"
      : "border-[#7c6cff50] bg-[#7c6cff1f] text-[#a99bff]";

  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`flex items-center gap-1 rounded-full border px-2 py-1 text-[10px] font-semibold transition ${
        active
          ? activeClasses
          : "border-[#252a34] bg-[#ffffff05] text-[#939aa7] hover:border-[#7c6cff50] hover:text-[#e7e9ee]"
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

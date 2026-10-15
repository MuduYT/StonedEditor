import { fetchJson, normalizeOpenRouterBaseUrl, type FetchLike } from "./api";

/* ------------------------------------------------------------------ *
 *  OpenRouter model catalogue
 *  ------------------------------------------------------------------
 *  Live source: GET https://openrouter.ai/api/v1/models (public)
 *  Cached in memory + localStorage, with a curated offline fallback.
 * ------------------------------------------------------------------ */

export interface AiModel {
  id: string;
  name: string;
  description?: string;
  provider: string;
  providerLabel: string;
  contextLength: number;
  maxCompletionTokens?: number;
  isFree: boolean;
  /** Router models report "-1" as price: variable / market driven. */
  priceVariable: boolean;
  promptPricePerMillion: number | null;
  completionPricePerMillion: number | null;
  inputModalities: string[];
  outputModalities: string[];
  supportsTools: boolean;
  supportsReasoning: boolean;
  supportsTemperature: boolean;
  created?: number;
  expirationDate?: string | null;
}

export type CatalogSource = "live" | "cache" | "fallback";

export interface ModelCatalog {
  models: AiModel[];
  source: CatalogSource;
  fetchedAt: number;
  error?: unknown;
}

export type ModelSort = "recommended" | "name" | "context" | "newest" | "cheapest";

export interface ModelFilterState {
  query: string;
  freeOnly: boolean;
  provider: string | null;
  modality: "any" | "image" | "audio" | "file" | "video";
  toolsOnly: boolean;
  reasoningOnly: boolean;
  sort: ModelSort;
}

export const EMPTY_FILTERS: ModelFilterState = {
  query: "",
  freeOnly: false,
  provider: null,
  modality: "any",
  toolsOnly: false,
  reasoningOnly: false,
  sort: "recommended",
};

/* ------------------------------------------------------------------ *
 *  Storage keys
 * ------------------------------------------------------------------ */

export const STORAGE_KEYS = {
  apiKey: "stoned_openrouter_api_key",
  baseUrl: "stoned_openrouter_base_url",
  model: "stoned_openrouter_model",
  favorites: "stoned_openrouter_favorites",
  catalog: "stoned_openrouter_catalog_v1",
  legacy: {
    apiKey: "freemodel_api_key",
    baseUrl: "freemodel_base_url",
    model: "freemodel_model",
  },
} as const;

/* ------------------------------------------------------------------ *
 *  Curated data (verified against the live catalogue)
 * ------------------------------------------------------------------ */

/** Hand picked shortlist, shown first with the "Empfohlen" sorting. */
export const RECOMMENDED_MODEL_IDS = [
  "openrouter/free",
  "anthropic/claude-sonnet-5.5",
  "openai/gpt-6.1-sol",
  "google/gemini-4-argon",
  "deepseek/deepseek-v4.1-flash",
  "x-ai/grok-4.7",
  "qwen/qwen3.8-max-prime",
  "google/gemma-4-31b-it:free",
  "nvidia/nemotron-3-super-120b-a12b:free",
  "cohere/north-mini-code:free",
] as const;

const PROVIDER_LABELS: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
  meta: "Meta",
  "meta-llama": "Meta",
  mistralai: "Mistral",
  deepseek: "DeepSeek",
  "deepseek-ai": "DeepSeek",
  qwen: "Qwen",
  "x-ai": "xAI",
  "z-ai": "Z.AI",
  nvidia: "NVIDIA",
  cohere: "Cohere",
  amazon: "Amazon",
  microsoft: "Microsoft",
  openrouter: "OpenRouter",
  moonshotai: "Moonshot",
  poolside: "Poolside",
  liquid: "LiquidAI",
  thinkingmachines: "Thinking Machines",
  "dots-studio": "Dots Studio",
  perplexity: "Perplexity",
  ai21: "AI21",
  allenai: "AllenAI",
  baidu: "Baidu",
  ibm: "IBM",
  inflection: "Inflection",
  minimax: "MiniMax",
  nousresearch: "Nous Research",
  "aion-labs": "Aion Labs",
  "arcee-ai": "Arcee AI",
  bytedance: "ByteDance",
  inception: "Inception",
  kwaipilot: "Kwaipilot",
  meituan: "Meituan",
  relace: "Relace",
  reka: "Reka",
  sao10k: "Sao10K",
  stepfun: "StepFun",
  switchpoint: "Switchpoint",
  tencent: "Tencent",
  upstage: "Upstage",
  writer: "Writer",
};

export function providerLabel(provider: string): string {
  if (!provider) {
    return "Unbekannt";
  }

  return (
    PROVIDER_LABELS[provider] ??
    provider.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
  );
}

/**
 * Used when the live catalogue cannot be reached (offline / rate limited).
 * Prices are USD per million tokens and were read from the live catalogue.
 */
export const CURATED_FALLBACK_MODELS: AiModel[] = (
  [
    ["openrouter/free", "Free Models Router", 200_000, true, 0, 0, ["text", "image"], true],
    ["google/gemma-4-31b-it:free", "Google: Gemma 4 31B (free)", 262_144, true, 0, 0, ["text", "image", "video"], true],
    ["google/gemma-4-26b-a4b-it:free", "Google: Gemma 4 26B A4B (free)", 262_144, true, 0, 0, ["text", "image", "video"], true],
    ["nvidia/nemotron-3-super-120b-a12b:free", "NVIDIA: Nemotron 3 Super (free)", 262_144, true, 0, 0, ["text"], true],
    ["nvidia/nemotron-3-ultra-550b-a55b:free", "NVIDIA: Nemotron 3 Ultra (free)", 1_000_000, true, 0, 0, ["text"], true],
    ["thinkingmachines/inkling:free", "Thinking Machines: Inkling (free)", 1_048_576, true, 0, 0, ["text", "image", "audio"], true],
    ["poolside/laguna-s-2.1:free", "Poolside: Laguna S 2.1 (free)", 262_144, true, 0, 0, ["text"], true],
    ["cohere/north-mini-code:free", "Cohere: North Mini Code (free)", 256_000, true, 0, 0, ["text"], true],
    ["liquid/lfm-2.5-2.6b:free", "LiquidAI: LFM2.5-2.6B (free)", 65_536, true, 0, 0, ["text"], true],
    ["anthropic/claude-sonnet-5.5", "Anthropic: Claude Sonnet 5.5", 1_000_000, false, 2, 10, ["text", "image", "file"], true],
    ["anthropic/claude-haiku-5.5", "Anthropic: Claude Haiku 5.5", 1_000_000, false, 0.1, 0.5, ["text", "image", "file"], true],
    ["anthropic/claude-opus-5.5", "Anthropic: Claude Opus 5.5", 1_000_000, false, 4, 20, ["text", "image", "file"], true],
    ["openai/gpt-6.1-sol", "OpenAI: GPT-6.1 Sol", 1_050_000, false, 2, 10, ["text", "image", "file"], true],
    ["google/gemini-4-argon", "Google: Gemini 4 Argon", 1_048_576, false, 2, 10, ["text", "image", "file", "audio", "video"], true],
    ["deepseek/deepseek-v4.1-flash", "DeepSeek: DeepSeek V4.1 Flash", 1_048_576, false, 0.024, 0.72, ["text", "image"], true],
    ["x-ai/grok-4.7", "SpaceXAI: Grok 4.7", 500_000, false, 2, 6, ["text", "image", "file"], true],
    ["qwen/qwen3.8-max-prime", "Qwen: Qwen3.8 Max Prime", 1_000_000, false, 4, 12, ["text", "image", "video"], true],
    ["meta-llama/llama-4-maverick", "Meta: Llama 4 Maverick", 1_048_576, false, 0.188, 0.653, ["text", "image"], true],
    ["mistralai/mistral-large-4-0", "Mistral: Mistral Large 4", 1_048_576, false, 0.68, 2.09, ["text", "image"], true],
  ] as const
).map(
  ([
    id,
    name,
    contextLength,
    isFree,
    promptPrice,
    completionPrice,
    inputModalities,
    supportsTools,
  ]) => ({
    id: id as string,
    name: name as string,
    provider: (id as string).split("/")[0],
    providerLabel: providerLabel((id as string).split("/")[0]),
    contextLength: contextLength as number,
    isFree: isFree as boolean,
    priceVariable: false,
    promptPricePerMillion: promptPrice as number,
    completionPricePerMillion: completionPrice as number,
    inputModalities: [...(inputModalities as readonly string[])],
    outputModalities: ["text"],
    supportsTools: supportsTools as boolean,
    supportsReasoning: false,
    supportsTemperature: true,
  }),
);

/* ------------------------------------------------------------------ *
 *  Normalisation
 * ------------------------------------------------------------------ */

interface RawModel {
  id?: string;
  canonical_slug?: string;
  name?: string;
  description?: string;
  created?: number;
  context_length?: number;
  architecture?: { input_modalities?: string[]; output_modalities?: string[] };
  pricing?: Record<string, string | undefined>;
  top_provider?: { context_length?: number; max_completion_tokens?: number };
  supported_parameters?: string[];
  expiration_date?: string | null;
}

function parsePricePerMillion(raw: string | undefined) {
  if (raw === undefined) {
    return { value: null as number | null, variable: false };
  }

  const numeric = Number(raw);

  if (!Number.isFinite(numeric) || numeric < 0) {
    return { value: null as number | null, variable: true };
  }

  return { value: Math.round(numeric * 1e6 * 1e6) / 1e6, variable: false };
}

export function normalizeModel(raw: RawModel): AiModel | null {
  const id = raw.id?.trim();

  if (!id) {
    return null;
  }

  const provider = id.split("/")[0] || "unknown";
  const prompt = parsePricePerMillion(raw.pricing?.prompt);
  const completion = parsePricePerMillion(raw.pricing?.completion);
  const supported = raw.supported_parameters ?? [];
  const isFree =
    id.endsWith(":free") ||
    (prompt.value === 0 && completion.value === 0) ||
    (typeof raw.pricing?.prompt === "string" && raw.pricing.prompt === "0" && raw.pricing.completion === "0");

  return {
    id,
    name: raw.name?.trim() || id,
    description: raw.description,
    provider,
    providerLabel: providerLabel(provider),
    contextLength: raw.context_length ?? raw.top_provider?.context_length ?? 0,
    maxCompletionTokens: raw.top_provider?.max_completion_tokens,
    isFree,
    priceVariable: prompt.variable || completion.variable,
    promptPricePerMillion: prompt.value,
    completionPricePerMillion: completion.value,
    inputModalities: raw.architecture?.input_modalities ?? ["text"],
    outputModalities: raw.architecture?.output_modalities ?? ["text"],
    supportsTools: supported.includes("tools"),
    supportsReasoning:
      supported.includes("reasoning") || supported.includes("include_reasoning"),
    supportsTemperature: supported.includes("temperature"),
    created: raw.created,
    expirationDate: raw.expiration_date ?? null,
  };
}

/* ------------------------------------------------------------------ *
 *  Catalogue loading
 * ------------------------------------------------------------------ */

const MEMORY_TTL_MS = 15 * 60 * 1000;

let memoryCache: { fetchedAt: number; models: AiModel[] } | null = null;

function readStoredCatalog(): { fetchedAt: number; models: AiModel[] } | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEYS.catalog);

    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as { fetchedAt?: number; models?: AiModel[] };

    if (!parsed?.models?.length || !parsed.fetchedAt) {
      return null;
    }

    return { fetchedAt: parsed.fetchedAt, models: parsed.models };
  } catch {
    return null;
  }
}

function writeStoredCatalog(models: AiModel[], fetchedAt: number) {
  memoryCache = { models, fetchedAt };

  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(
      STORAGE_KEYS.catalog,
      JSON.stringify({ fetchedAt, models }),
    );
  } catch {
    // Storage full / disabled – the in-memory cache still works.
  }
}

export async function fetchLiveCatalog(options: {
  baseUrl?: string;
  signal?: AbortSignal;
  fetchImpl?: FetchLike;
}): Promise<AiModel[]> {
  const { baseUrl, signal, fetchImpl } = options;
  const payload = await fetchJson<{ data?: RawModel[] } | RawModel[]>(
    `${normalizeOpenRouterBaseUrl(baseUrl)}/models`,
    { signal, fetchImpl, timeoutMs: 25_000 },
  );

  const rawModels = Array.isArray(payload) ? payload : payload?.data ?? [];
  const models = rawModels
    .map(normalizeModel)
    .filter((model): model is AiModel => Boolean(model))
    // A chat needs text in *and* text out – this hides audio/image/music models
    // (e.g. the free Lyria endpoints) that cannot answer in a chat window.
    .filter(
      (model) =>
        model.inputModalities.includes("text") &&
        model.outputModalities.includes("text"),
    )
    .sort((a, b) => a.id.localeCompare(b.id));

  if (models.length === 0) {
    throw new Error("OpenRouter hat eine leere Modellliste geliefert.");
  }

  return models;
}

/**
 * Loads the catalogue: fresh memory → fresh localStorage → live → cached → curated.
 * Never throws, so the picker always has something to show.
 */
export async function loadModelCatalog(options: {
  baseUrl?: string;
  signal?: AbortSignal;
  fetchImpl?: FetchLike;
  force?: boolean;
  maxAgeMs?: number;
} = {}): Promise<ModelCatalog> {
  const { force = false, maxAgeMs = MEMORY_TTL_MS } = options;
  const now = Date.now();

  if (!force && memoryCache && now - memoryCache.fetchedAt < maxAgeMs) {
    return {
      models: memoryCache.models,
      source: "live",
      fetchedAt: memoryCache.fetchedAt,
    };
  }

  const stored = readStoredCatalog();

  if (!force && stored && now - stored.fetchedAt < maxAgeMs) {
    memoryCache = stored;
    return { models: stored.models, source: "cache", fetchedAt: stored.fetchedAt };
  }

  try {
    const models = await fetchLiveCatalog(options);
    writeStoredCatalog(models, now);
    return { models, source: "live", fetchedAt: now };
  } catch (error) {
    if (stored) {
      memoryCache = stored;
      return {
        models: stored.models,
        source: "cache",
        fetchedAt: stored.fetchedAt,
        error,
      };
    }

    return {
      models: CURATED_FALLBACK_MODELS,
      source: "fallback",
      fetchedAt: now,
      error,
    };
  }
}

/* ------------------------------------------------------------------ *
 *  Filtering & sorting
 * ------------------------------------------------------------------ */

function matchesQuery(model: AiModel, query: string) {
  if (!query) {
    return true;
  }

  const haystack = `${model.id} ${model.name} ${model.providerLabel} ${model.description ?? ""}`.toLowerCase();

  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((term) => haystack.includes(term));
}

export function filterModels(models: AiModel[], filters: ModelFilterState): AiModel[] {
  const filtered = models.filter((model) => {
    if (filters.freeOnly && !model.isFree) {
      return false;
    }

    if (filters.provider && model.provider !== filters.provider) {
      return false;
    }

    if (filters.modality !== "any" && !model.inputModalities.includes(filters.modality)) {
      return false;
    }

    if (filters.toolsOnly && !model.supportsTools) {
      return false;
    }

    if (filters.reasoningOnly && !model.supportsReasoning) {
      return false;
    }

    return matchesQuery(model, filters.query);
  });

  return sortModels(filtered, filters.sort);
}

export function sortModels(models: AiModel[], sort: ModelSort): AiModel[] {
  const copy = [...models];

  switch (sort) {
    case "name":
      return copy.sort((a, b) => a.name.localeCompare(b.name, "de"));
    case "context":
      return copy.sort((a, b) => b.contextLength - a.contextLength || a.name.localeCompare(b.name, "de"));
    case "newest":
      return copy.sort((a, b) => (b.created ?? 0) - (a.created ?? 0));
    case "cheapest":
      return copy.sort((a, b) => {
        if (a.isFree !== b.isFree) {
          return a.isFree ? -1 : 1;
        }

        const left = a.completionPricePerMillion ?? Number.POSITIVE_INFINITY;
        const right = b.completionPricePerMillion ?? Number.POSITIVE_INFINITY;

        return left - right || a.name.localeCompare(b.name, "de");
      });
    case "recommended":
    default: {
      const rank = new Map<string, number>();
      RECOMMENDED_MODEL_IDS.forEach((id, index) => rank.set(id, index));

      return copy.sort((a, b) => {
        const left = rank.get(a.id);
        const right = rank.get(b.id);

        if (left !== undefined || right !== undefined) {
          return (left ?? Number.MAX_SAFE_INTEGER) - (right ?? Number.MAX_SAFE_INTEGER);
        }

        return (b.created ?? 0) - (a.created ?? 0) || a.name.localeCompare(b.name, "de");
      });
    }
  }
}

export function listProviders(models: AiModel[]) {
  const counts = new Map<string, { provider: string; label: string; count: number }>();

  for (const model of models) {
    const entry = counts.get(model.provider) ?? {
      provider: model.provider,
      label: model.providerLabel,
      count: 0,
    };
    entry.count += 1;
    counts.set(model.provider, entry);
  }

  return [...counts.values()].sort((a, b) =>
    b.count - a.count || a.label.localeCompare(b.label, "de"),
  );
}

export function pickDefaultModel(models: AiModel[], storedId?: string | null) {
  if (storedId && models.some((model) => model.id === storedId)) {
    return storedId;
  }

  // A fresh account usually has no credits: start with a free model that is
  // known to answer, so the very first message already works.
  for (const id of RELIABLE_FREE_MODEL_IDS) {
    if (models.some((model) => model.id === id && model.isFree)) {
      return id;
    }
  }

  const freeRouter = models.find((model) => model.id === "openrouter/free");

  if (freeRouter) {
    return freeRouter.id;
  }

  const firstFree = models.find((model) => model.isFree);

  if (firstFree) {
    return firstFree.id;
  }

  return models[0]?.id ?? "";
}

/**
 * OpenRouter accepts at most 3 entries in the `models` fallback array
 * (observed via the live API: "'models' array must have 3 items or fewer.").
 */
export const MAX_MODEL_FALLBACKS = 2;

/**
 * Free models that answered reliably in live measurements (content + speed).
 * Used to order the fallback chain so no time is wasted on endpoints that are
 * currently unavailable for everyone (e.g. the Google AI Studio free pool).
 */
export const RELIABLE_FREE_MODEL_IDS = [
  "cohere/north-mini-code:free",
  "nvidia/nemotron-3-super-120b-a12b:free",
  "openrouter/free",
  "poolside/laguna-xs-2.1:free",
  "liquid/lfm-2.5-2.6b:free",
  "nvidia/nemotron-3-ultra-550b-a55b:free",
  "dots-studio/dots-3-note-preview:free",
] as const;

/**
 * Free fallback chain for OpenRouter's `models` array: if the chosen free
 * endpoint is unavailable, OpenRouter answers with the next model in the list.
 * Only free models are ever added, so this can never cost money.
 */
export function freeFallbackIds(
  models: AiModel[],
  primaryId: string,
  limit = MAX_MODEL_FALLBACKS,
): string[] {
  const freeIds = models.filter((model) => model.isFree).map((model) => model.id);
  const reliable = RELIABLE_FREE_MODEL_IDS.filter(
    (id) => freeIds.includes(id) && id !== primaryId,
  );
  const recommended = RECOMMENDED_MODEL_IDS.filter(
    (id) =>
      freeIds.includes(id) &&
      id !== primaryId &&
      !reliable.includes(id as (typeof RELIABLE_FREE_MODEL_IDS)[number]),
  );
  const known = new Set<string>([...reliable, ...recommended]);
  const rest = freeIds.filter((id) => id !== primaryId && !known.has(id));

  return [...reliable, ...recommended, ...rest].slice(0, limit);
}

export function findModel(models: AiModel[], id: string | null | undefined) {
  if (!id) {
    return undefined;
  }

  return models.find((model) => model.id === id);
}

/* ------------------------------------------------------------------ *
 *  Display helpers
 * ------------------------------------------------------------------ */

/** "Anthropic: Claude Sonnet 5.5" → "Claude Sonnet 5.5" */
export function displayName(model: Pick<AiModel, "name">) {
  return model.name.replace(/^\s*[^:]{0,24}:\s*/, "").trim() || model.name;
}

export function formatContextLength(tokens: number) {
  if (!tokens) {
    return "unbekannt";
  }

  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000;

    return `${Number.isInteger(millions) ? millions : millions.toFixed(1).replace(/\.0$/, "")}M Tok.`;
  }

  if (tokens >= 1000) {
    return `${Math.round(tokens / 1000)}K Tok.`;
  }

  return `${tokens} Tok.`;
}

export function formatPrice(model: Pick<AiModel, "isFree" | "priceVariable" | "promptPricePerMillion" | "completionPricePerMillion">) {
  if (model.isFree) {
    return "Kostenlos";
  }

  if (model.priceVariable || model.promptPricePerMillion === null) {
    return "Preis variabel";
  }

  const input = model.promptPricePerMillion ?? 0;
  const output = model.completionPricePerMillion ?? 0;

  return `$${formatUsd(input)} ein / $${formatUsd(output)} aus pro Mio Tok.`;
}

function formatUsd(value: number) {
  if (value === 0) {
    return "0";
  }

  if (value < 0.01) {
    return value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
  }

  if (value < 1) {
    return value.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
  }

  return value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

export function modalityLabel(modality: string) {
  switch (modality) {
    case "image":
      return "Bilder";
    case "audio":
      return "Audio";
    case "video":
      return "Video";
    case "file":
      return "Dateien";
    default:
      return "Text";
  }
}

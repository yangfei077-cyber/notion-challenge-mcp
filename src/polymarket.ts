/**
 * Polymarket Gamma API client — read-only market data.
 * Docs: https://docs.polymarket.com
 */

const GAMMA_API = "https://gamma-api.polymarket.com";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface PolyMarket {
  id: string;
  condition_id?: string;
  conditionId?: string;
  question: string;
  slug: string;
  outcomes: string;        // JSON array of outcome names
  outcomePrices: string;   // JSON array of prices
  volume: string | number;
  liquidity: string | number;
  endDate: string;
  active: boolean;
  closed: boolean;
  category?: string;
  description?: string;
  image?: string;
  tags?: { label: string; slug: string }[];
}

export interface PolyEvent {
  id: string;
  title: string;
  slug: string;
  markets: PolyMarket[];
  category?: string;
  volume: number;
  liquidity: number;
}

export interface ParsedOutcome {
  name: string;
  price: number;
  impliedProb: string;   // e.g. "72.3%"
}

// ─── Core fetch ─────────────────────────────────────────────────────────────

async function gammaFetch<T>(path: string, params?: Record<string, string>): Promise<T> {
  const url = new URL(path, GAMMA_API);
  if (params) {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  }
  const res = await fetch(url.toString(), {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`Polymarket API ${res.status}: ${await res.text()}`);
  }
  return res.json() as Promise<T>;
}

// ─── Public API ─────────────────────────────────────────────────────────────

export async function getTrendingMarkets(limit = 20): Promise<PolyMarket[]> {
  return gammaFetch<PolyMarket[]>("/markets", {
    limit: String(limit),
    active: "true",
    closed: "false",
    order: "volume",
    ascending: "false",
  });
}

export async function getMarketById(id: string): Promise<PolyMarket> {
  // Gamma API returns an array when querying by condition_id
  const results = await gammaFetch<PolyMarket[]>("/markets", { id });
  if (results.length === 0) {
    // Try single-market endpoint
    return gammaFetch<PolyMarket>(`/markets/${id}`);
  }
  return results[0];
}

export async function getMarketBySlug(slug: string): Promise<PolyMarket | null> {
  const results = await gammaFetch<PolyMarket[]>("/markets", { slug });
  return results[0] ?? null;
}

export async function searchMarkets(query: string, limit = 20): Promise<PolyMarket[]> {
  // Gamma doesn't have text search — fetch a large batch and filter client-side
  const markets = await gammaFetch<PolyMarket[]>("/markets", {
    limit: "100",
    active: "true",
    closed: "false",
    order: "volume",
    ascending: "false",
  });
  const q = query.toLowerCase();
  return markets
    .filter(
      (m) =>
        m.question.toLowerCase().includes(q) ||
        (m.description ?? "").toLowerCase().includes(q) ||
        (m.category ?? "").toLowerCase().includes(q) ||
        (m.slug ?? "").toLowerCase().includes(q),
    )
    .slice(0, limit);
}

export async function getEvents(limit = 10): Promise<PolyEvent[]> {
  return gammaFetch<PolyEvent[]>("/events", {
    limit: String(limit),
    active: "true",
    closed: "false",
    order: "volume",
    ascending: "false",
  });
}

export async function getEventById(id: string): Promise<PolyEvent> {
  return gammaFetch<PolyEvent>(`/events/${id}`);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

export function parseOutcomes(m: PolyMarket): ParsedOutcome[] {
  try {
    const names: string[] = JSON.parse(m.outcomes || "[]");
    const prices: string[] = JSON.parse(m.outcomePrices || "[]");
    return names.map((name, i) => ({
      name,
      price: parseFloat(prices[i] ?? "0"),
      impliedProb: `${(parseFloat(prices[i] ?? "0") * 100).toFixed(1)}%`,
    }));
  } catch {
    return [];
  }
}

export function yesPrice(m: PolyMarket): number {
  const outcomes = parseOutcomes(m);
  return outcomes.find((o) => o.name.toLowerCase() === "yes")?.price ?? outcomes[0]?.price ?? 0;
}

export function formatVolume(v: number): string {
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}

export function formatMarketOneLiner(m: PolyMarket, index?: number): string {
  const outcomes = parseOutcomes(m);
  const top = outcomes.sort((a, b) => b.price - a.price)[0];
  const prefix = index !== undefined ? `${index + 1}. ` : "";
  return [
    `${prefix}**${m.question}**`,
    `   ID: \`${m.id}\``,
    top ? `   Leading: ${top.name} @ ${top.impliedProb}` : "",
    `   Vol: ${formatVolume(num(m.volume))} | Liq: ${formatVolume(num(m.liquidity))} | End: ${m.endDate?.split("T")[0] ?? "N/A"}`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function formatMarketFull(m: PolyMarket): string {
  const outcomes = parseOutcomes(m);
  return [
    `# ${m.question}`,
    "",
    `**ID:** \`${m.id}\``,
    `**Category:** ${m.category ?? "N/A"}`,
    `**Volume:** ${formatVolume(num(m.volume))} | **Liquidity:** ${formatVolume(num(m.liquidity))}`,
    `**End Date:** ${m.endDate?.split("T")[0] ?? "N/A"}`,
    `**Active:** ${m.active} | **Closed:** ${m.closed}`,
    "",
    "## Current Odds",
    ...outcomes.map((o) => `- **${o.name}:** ${o.impliedProb} ($${o.price.toFixed(3)})`),
    "",
    "## Description",
    m.description ? truncate(m.description, 2000) : "N/A",
  ].join("\n");
}

export function truncate(s: string, max = 2000): string {
  return s.length > max ? s.slice(0, max - 3) + "..." : s;
}

/** Safely parse volume/liquidity which may be string or number from the API */
export function num(v: string | number | undefined): number {
  if (v === undefined || v === null) return 0;
  const n = typeof v === "string" ? parseFloat(v) : v;
  return Number.isFinite(n) ? n : 0;
}

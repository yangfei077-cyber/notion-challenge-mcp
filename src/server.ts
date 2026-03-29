import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  getTrendingMarkets,
  getMarketById,
  searchMarkets,
  getEvents,
  getEventById,
  parseOutcomes,
  yesPrice,
  formatVolume,
  formatMarketOneLiner,
  formatMarketFull,
  truncate,
  num,
  type PolyMarket,
} from "./polymarket.js";

// ─── Notion direct API client ───────────────────────────────────────────────

const NOTION_TOKEN = process.env.NOTION_TOKEN || "";
const NOTION_API = "https://api.notion.com/v1";

async function notionFetch(path: string, method = "GET", body?: any): Promise<any> {
  if (!NOTION_TOKEN) throw new Error("NOTION_TOKEN not set");
  const res = await fetch(`${NOTION_API}${path}`, {
    method,
    headers: {
      "Authorization": `Bearer ${NOTION_TOKEN}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Notion API ${res.status}: ${errText.slice(0, 200)}`);
  }
  return res.json();
}

async function notionQueryDatabase(dbId: string): Promise<any[]> {
  const data = await notionFetch(`/databases/${dbId}/query`, "POST", {});
  return data.results || [];
}

function notionGetTitle(page: any): string {
  const titleProp = Object.values(page.properties).find((p: any) => p.type === "title") as any;
  return titleProp?.title?.[0]?.plain_text || "";
}

function notionGetRichText(page: any, propName: string): string {
  return page.properties?.[propName]?.rich_text?.[0]?.plain_text || "";
}

function notionGetCheckbox(page: any, propName: string): boolean {
  return page.properties?.[propName]?.checkbox === true;
}

function notionGetSelect(page: any, propName: string): string {
  return page.properties?.[propName]?.select?.name || "";
}

async function notionUpdatePage(pageId: string, properties: Record<string, any>): Promise<void> {
  await notionFetch(`/pages/${pageId}`, "PATCH", { properties });
}

async function notionCreatePage(parentDbId: string, properties: Record<string, any>): Promise<any> {
  return notionFetch("/pages", "POST", {
    parent: { database_id: parentDbId },
    properties,
  });
}

async function notionAppendBlocks(pageId: string, children: any[]): Promise<void> {
  // Notion API limits to 100 blocks per request
  for (let i = 0; i < children.length; i += 100) {
    await notionFetch(`/blocks/${pageId}/children`, "PATCH", {
      children: children.slice(i, i + 100),
    });
  }
}

// ─── Auto-watch state ───────────────────────────────────────────────────────

let watchInterval: ReturnType<typeof setInterval> | null = null;
let watchConfig: { watchlistDbId: string; researchDbId?: string } | null = null;

const WATCH_INTERVAL_MS = parseInt(process.env.WATCH_INTERVAL || "10") * 1000; // default 10s
const WATCHLIST_DB_ID = process.env.WATCHLIST_DB_ID || "";
const RESEARCH_DB_ID = process.env.RESEARCH_DB_ID || "";

// Auto-discover databases by searching Notion
async function autoDiscoverDatabases(): Promise<{ watchlistId: string; researchId?: string }> {
  // If env vars are set, use those
  if (WATCHLIST_DB_ID) {
    return { watchlistId: WATCHLIST_DB_ID, researchId: RESEARCH_DB_ID || undefined };
  }
  // Otherwise search Notion for our databases
  const results = await notionFetch("/search", "POST", {
    query: "Market Watchlist",
    filter: { property: "object", value: "database" },
  });
  const watchlist = results.results?.find((r: any) =>
    r.title?.[0]?.plain_text?.includes("Watchlist") || r.title?.[0]?.plain_text?.includes("watchlist")
  );
  if (!watchlist) throw new Error("No Watchlist database found in Notion");

  // Also look for Research Reports
  const resResults = await notionFetch("/search", "POST", {
    query: "Research Reports",
    filter: { property: "object", value: "database" },
  });
  const research = resResults.results?.find((r: any) =>
    r.title?.[0]?.plain_text?.includes("Research")
  );

  return { watchlistId: watchlist.id, researchId: research?.id };
}

// ─── Notion schema templates (for use with the official Notion MCP) ─────────

const WATCHLIST_SCHEMA = {
  "Market": { title: {} },
  "Market ID": { rich_text: {} },
  "Category": {
    select: {
      options: [
        { name: "Politics", color: "red" },
        { name: "Crypto", color: "purple" },
        { name: "Sports", color: "green" },
        { name: "Science", color: "blue" },
        { name: "Culture", color: "orange" },
        { name: "Business", color: "yellow" },
        { name: "Other", color: "gray" },
      ],
    },
  },
  "Yes Price": { number: { format: "percent" } },
  "No Price": { number: { format: "percent" } },
  "Volume": { number: { format: "dollar" } },
  "Liquidity": { number: { format: "dollar" } },
  "End Date": { date: {} },
  "Signal": {
    select: {
      options: [
        { name: "Strong Buy", color: "green" },
        { name: "Buy", color: "blue" },
        { name: "Hold", color: "gray" },
        { name: "Sell", color: "yellow" },
        { name: "Strong Sell", color: "red" },
        { name: "Researching", color: "purple" },
      ],
    },
  },
  "Fair Value": { number: { format: "percent" } },
  "Edge": { number: { format: "percent" } },
  "Research Status": {
    select: {
      options: [
        { name: "Pending", color: "gray" },
        { name: "In Progress", color: "yellow" },
        { name: "Complete", color: "green" },
      ],
    },
  },
  "Human Approval": {
    select: {
      options: [
        { name: "Pending Review", color: "yellow" },
        { name: "Approved", color: "green" },
        { name: "Rejected", color: "red" },
        { name: "Needs More Research", color: "orange" },
      ],
    },
  },
  "Human Notes": { rich_text: {} },
  "Human Fair Value": { number: { format: "percent" } },
  "🔬 Research": { checkbox: {} },
};

const RESEARCH_SCHEMA = {
  "Title": { title: {} },
  "Market": { rich_text: {} },
  "Market ID": { rich_text: {} },
  "Conviction": {
    select: {
      options: [
        { name: "Strong Buy", color: "green" },
        { name: "Buy", color: "blue" },
        { name: "Hold", color: "gray" },
        { name: "Sell", color: "yellow" },
        { name: "Strong Sell", color: "red" },
      ],
    },
  },
  "Fair Value": { number: { format: "percent" } },
  "Market Price": { number: { format: "percent" } },
  "Edge": { number: { format: "percent" } },
  "Confidence": {
    select: {
      options: [
        { name: "High", color: "green" },
        { name: "Medium", color: "yellow" },
        { name: "Low", color: "red" },
      ],
    },
  },
  "Date": { date: {} },
  "Iteration": { number: {} },
};

const JOURNAL_SCHEMA = {
  "Trade": { title: {} },
  "Market": { rich_text: {} },
  "Market ID": { rich_text: {} },
  "Side": {
    select: {
      options: [
        { name: "Yes", color: "green" },
        { name: "No", color: "red" },
      ],
    },
  },
  "Entry Price": { number: { format: "percent" } },
  "Size": { number: { format: "dollar" } },
  "Current Price": { number: { format: "percent" } },
  "PnL ($)": { number: { format: "dollar" } },
  "PnL (%)": { number: { format: "percent" } },
  "Status": {
    select: {
      options: [
        { name: "Open", color: "blue" },
        { name: "Won", color: "green" },
        { name: "Lost", color: "red" },
        { name: "Pending Approval", color: "yellow" },
      ],
    },
  },
  "Entry Date": { date: {} },
  "Exit Date": { date: {} },
};

// ─── Ollama integration ─────────────────────────────────────────────────────

const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "qwen2.5:14b";

interface OllamaResearch {
  conviction: string;
  fair_value: number;
  confidence: string;
  edge: number;
  base_rate: string;
  evidence: string[];
  risks: string[];
  analysis: string;
}

async function callOllama(prompt: string): Promise<OllamaResearch> {
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      messages: [
        {
          role: "system",
          content:
            "You are an expert prediction market analyst. Always respond with valid JSON only, no markdown formatting.",
        },
        { role: "user", content: prompt },
      ],
      stream: false,
      options: { temperature: 0.3 },
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Ollama error ${res.status}: ${errText}`);
  }

  const data: any = await res.json();
  const rawContent = data.message?.content || "";

  try {
    const jsonMatch = rawContent.match(/\{[\s\S]*\}/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
  } catch {}

  return {
    conviction: "Hold",
    fair_value: 0.5,
    confidence: "Low",
    edge: 0,
    base_rate: rawContent.slice(0, 200),
    evidence: [],
    risks: [],
    analysis: rawContent,
  };
}

function buildOllamaPrompt(m: PolyMarket, iteration: number): string {
  const outcomes = parseOutcomes(m);
  const outcomeStr = outcomes
    .map((o) => `- ${o.name}: ${o.impliedProb} ($${o.price.toFixed(3)})`)
    .join("\n");

  return `You are an expert prediction market analyst. Analyze this Polymarket market and provide a structured research report.

## Market
**${m.question}**

## Current Odds
${outcomeStr}

## Stats
- Volume: ${formatVolume(num(m.volume))}
- Liquidity: ${formatVolume(num(m.liquidity))}
- End Date: ${m.endDate?.split("T")[0] ?? "N/A"}

## Description
${truncate(m.description ?? "N/A", 1500)}

---

Provide your analysis in this exact JSON format (no markdown, just raw JSON):
{
  "conviction": "Strong Buy" | "Buy" | "Hold" | "Sell" | "Strong Sell",
  "fair_value": <number 0-1, your estimated fair probability for Yes>,
  "confidence": "High" | "Medium" | "Low",
  "edge": <number, fair_value minus current Yes price>,
  "base_rate": "<1-2 sentences on historical base rate>",
  "evidence": ["<key evidence point 1>", "<key evidence point 2>", "<key evidence point 3>"],
  "risks": ["<risk 1>", "<risk 2>"],
  "analysis": "<2-3 paragraph analysis>",
  "iteration": ${iteration}
}`;
}

// ─── Helper: generate auto-research prompt ──────────────────────────────────

function buildResearchPrompt(m: PolyMarket, iteration: number): string {
  const outcomes = parseOutcomes(m);
  const outcomeStr = outcomes
    .map((o) => `- **${o.name}:** ${o.impliedProb} ($${o.price.toFixed(3)})`)
    .join("\n");

  return [
    `# Auto Research — Iteration #${iteration}`,
    "",
    `## Target Market`,
    `**${m.question}**`,
    `ID: \`${m.id}\``,
    "",
    `## Current Odds`,
    outcomeStr,
    "",
    `## Market Stats`,
    `- Volume: ${formatVolume(num(m.volume))}`,
    `- Liquidity: ${formatVolume(num(m.liquidity))}`,
    `- End Date: ${m.endDate?.split("T")[0] ?? "N/A"}`,
    `- Category: ${m.category ?? "N/A"}`,
    "",
    `## Description`,
    truncate(m.description ?? "N/A", 1500),
    "",
    `---`,
    "",
    `## Research Instructions`,
    `Analyze this prediction market. Structure your research as follows:`,
    "",
    `### 1. Base Rate Analysis`,
    `What is the historical base rate for this type of event?`,
    "",
    `### 2. Recent Evidence`,
    `What recent news, data, or developments shift the probability?`,
    `List 3-5 key pieces of evidence with sources.`,
    "",
    `### 3. Market Efficiency Check`,
    `Is the current market price (implied probability) fair?`,
    `Common biases: favorite-longshot bias, recency bias, narrative bias.`,
    "",
    `### 4. Fair Value Estimate`,
    `What is your estimated fair probability for each outcome?`,
    `Show your reasoning.`,
    "",
    `### 5. Edge & Conviction`,
    `- Fair value vs market price = edge`,
    `- Rate conviction: Strong Buy / Buy / Hold / Sell / Strong Sell`,
    `- Rate confidence: High / Medium / Low`,
    "",
    `### 6. Risk Factors`,
    `What could go wrong? What information gaps exist?`,
    "",
    `---`,
    "",
    `## Ratchet Rule (inspired by Karpathy's autoresearch)`,
    `This is iteration #${iteration}.`,
    iteration === 1
      ? `First pass — establish baseline analysis.`
      : `Compare with previous iteration. Only update conviction if new evidence warrants it.`,
    `Log your findings using the Notion MCP to create a research report page.`,
  ].join("\n");
}

// ─── Build the MCP Server ───────────────────────────────────────────────────

export function createServer(): McpServer {
  const server = new McpServer(
    {
      name: "polydesk-mcp",
      version: "1.0.0",
    },
    {
      capabilities: {
        logging: {},
      },
    },
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // RESOURCES — Notion database schemas for the trading desk
  // ═══════════════════════════════════════════════════════════════════════════

  server.resource(
    "notion-schemas",
    "polydesk://schemas/notion-databases",
    async () => ({
      contents: [
        {
          uri: "polydesk://schemas/notion-databases",
          mimeType: "application/json",
          text: JSON.stringify(
            {
              description:
                "Notion database schemas for the PolyDesk trading desk. Use these with the official Notion MCP server's create_database tool.",
              databases: {
                watchlist: {
                  title: "Market Watchlist",
                  icon: "👁️",
                  properties: WATCHLIST_SCHEMA,
                },
                research: {
                  title: "Research Reports",
                  icon: "🔬",
                  properties: RESEARCH_SCHEMA,
                },
                journal: {
                  title: "Trade Journal",
                  icon: "📒",
                  properties: JOURNAL_SCHEMA,
                },
              },
            },
            null,
            2,
          ),
        },
      ],
    }),
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // PROMPTS — Pre-built workflows for the AI agent
  // ═══════════════════════════════════════════════════════════════════════════

  server.prompt(
    "setup-trading-desk",
    "Bootstrap the full PolyDesk workspace in Notion: creates dashboard page, 3 databases, and populates with live Polymarket data in spreadsheet view.",
    () => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: [
              "Set up my PolyDesk trading desk in Notion. Use ENGLISH for all content. Follow these steps:",
              "",
              "## Step 1: Create Main Page",
              "Create a page titled 'PolyDesk Trading Desk' with icon 📊.",
              "Add these blocks to the page using API-patch-block-children:",
              "",
              "- callout (icon: 🚀, blue_background): 'AI-powered prediction market research & trading control plane. Powered by Polymarket data + Karpathy autoresearch ratchet.'",
              "- divider",
              "- callout (icon: 🔒, green_background): 'Human-in-the-loop: AI researches → you review in this spreadsheet → only approved trades get planned. Nothing happens without your sign-off.'",
              "- divider",
              "",
              "## Step 2: Create Databases",
              "Read the `polydesk://schemas/notion-databases` resource for schemas.",
              "Create 3 inline databases under the main page:",
              "",
              "1. **Market Watchlist** (icon: 👁️) — the main spreadsheet. Show as TABLE view with columns: Market, Yes Price, Volume, Signal, Edge, Research Status, Human Approval",
              "2. **Research Reports** (icon: 🔬) — each entry becomes a rich research page",
              "3. **Trade Journal** (icon: 📒) — tracks execution plans",
              "",
              "## Step 3: Populate Watchlist with Live Data",
              "Use `scan_trending_markets` (limit 10) to get live Polymarket data.",
              "For each market, use `format_watchlist_entry` to generate the properties.",
              "Add each as a row in the Watchlist database via API-post-page.",
              "Set Research Status = 'Pending' and Human Approval = 'Pending Review' for all.",
              "",
              "## Step 4: Run Research on Top 3",
              "Pick the top 3 markets by volume.",
              "For each:",
              "1. Call `auto_research_market` and analyze it",
              "2. Call `format_research_for_notion` with your analysis results",
              "3. Create a page in the Research Reports database via API-post-page",
              "4. Write the beautiful blocks to that page via API-patch-block-children",
              "5. Update the Watchlist row: set Signal, Fair Value, Edge, Research Status = 'Complete'",
              "",
              "## Step 5: Summary",
              "Report: database IDs, which markets were researched, and their signals.",
              "Tell the user: 'Review the Watchlist spreadsheet. Change Human Approval to Approved/Rejected for any market. Then tell me to proceed.'",
            ].join("\n"),
          },
        },
      ],
    }),
  );

  server.prompt(
    "daily-research-loop",
    "Run a full auto-research cycle: scan trending markets, research top picks, update the watchlist.",
    { market_count: z.string().default("5").describe("How many markets to research") },
    (args) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: [
              `Run the daily PolyDesk research loop for the top ${args.market_count} markets:`,
              "",
              "1. Use `scan_trending_markets` to find the hottest markets",
              `2. For the top ${args.market_count} markets, use \`auto_research_market\` to generate research prompts`,
              "3. Analyze each market following the research prompt structure",
              "4. For each market:",
              "   a. Use `format_watchlist_entry` to get the properties, then add to Watchlist via Notion MCP's API-post-page",
              "   b. Create a Research Report page via API-post-page in the Research database",
              "   c. Use `format_research_for_notion` to get beautiful block content, then write it to the page via API-patch-block-children",
              "5. At the end, give me a summary of signals:",
              "   - Which markets have edge > 5%?",
              "   - Any signal changes from previous research?",
              "   - Recommended trades to review",
              "",
              "Follow the autoresearch ratchet principle: only upgrade a conviction if the evidence is stronger than the previous iteration.",
            ].join("\n"),
          },
        },
      ],
    }),
  );

  server.prompt(
    "trade-review",
    "Review open positions, sync prices, and generate a P&L summary.",
    () => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: [
              "Review my open positions in PolyDesk:",
              "",
              "1. Read all entries in the Trade Journal database where Status = 'Open'",
              "2. For each open trade, use `get_market` to fetch the current price",
              "3. Calculate P&L for each position",
              "4. Update each Trade Journal entry in Notion with:",
              "   - Current Price",
              "   - PnL ($) and PnL (%)",
              "   - If the position hit stop-loss or take-profit levels, flag it",
              "5. Give me a summary table of all open positions with current P&L",
              "6. Highlight any positions that need attention (large drawdown, nearing expiry, etc.)",
            ].join("\n"),
          },
        },
      ],
    }),
  );

  server.prompt(
    "review-and-execute",
    "Human-in-the-loop workflow: read back human approvals from Notion, then execute only approved trades. Nothing happens without human sign-off.",
    () => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: [
              "Run the PolyDesk human-in-the-loop review cycle:",
              "",
              "## Step 1: Read Human Decisions",
              "Query the Watchlist database using the Notion MCP. Look at these fields:",
              "- **Human Approval**: 'Approved', 'Rejected', 'Needs More Research', or 'Pending Review'",
              "- **Human Fair Value**: If the human overrode the AI's fair value estimate",
              "- **Human Notes**: Any comments the human left",
              "",
              "## Step 2: Process Approved Markets",
              "For each market where Human Approval = 'Approved':",
              "1. Fetch the latest price using `get_market`",
              "2. Use the human's Fair Value (if set) OR the AI's Fair Value",
              "3. Recalculate edge with current price",
              "4. Use `calculate_trade` to generate a trade plan",
              "5. Write the trade plan to the Trade Journal with Status = 'Pending Approval'",
              "",
              "## Step 3: Handle Other Signals",
              "- **Rejected**: Skip, update Research Status to 'Complete'",
              "- **Needs More Research**: Re-run `auto_research_market` with iteration + 1",
              "- **Pending Review**: Leave as-is, remind me to review",
              "",
              "## Step 4: Summary",
              "Give me a table showing:",
              "| Market | Human Decision | Action Taken | Edge | Trade Size |",
              "",
              "## CRITICAL RULE",
              "**NEVER execute a trade without 'Approved' status.** This is the human-in-the-loop guarantee.",
            ].join("\n"),
          },
        },
      ],
    }),
  );

  server.prompt(
    "research-then-review",
    "Full cycle: scan markets → auto research → write to Notion → WAIT for human review → execute approved trades only.",
    { market_count: z.string().default("3").describe("How many markets to research") },
    (args) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: [
              `Run a full PolyDesk research-to-execution cycle for ${args.market_count} markets:`,
              "",
              "## Phase 1: Research (AI does this now)",
              "1. Use `scan_trending_markets` to find hot markets",
              `2. Pick the top ${args.market_count} by volume`,
              "3. For each, run `auto_research_market` and analyze",
              "4. Write findings to Notion:",
              "   a. Use `format_watchlist_entry` → pass properties to Notion MCP's API-post-page (Watchlist DB)",
              "   b. Create a Research page via API-post-page (Research DB)",
              "   c. Use `format_research_for_notion` → pass blocks to API-patch-block-children",
              "   - All entries will have **Human Approval** = 'Pending Review'",
              "",
              "## Phase 2: Human Review (human does this in Notion)",
              "Tell the user: 'I've written my research to Notion. Please review each market in the Watchlist:'",
              "- Change **Human Approval** to 'Approved' / 'Rejected' / 'Needs More Research'",
              "- Optionally override **Human Fair Value** with your own estimate",
              "- Add any **Human Notes**",
              "",
              "## Phase 3: Execution (AI does this after human review)",
              "When the user says 'proceed' or 'execute':",
              "1. Read back the Watchlist from Notion",
              "2. Only process markets with Human Approval = 'Approved'",
              "3. Calculate trades and write to Trade Journal",
              "",
              "**Nothing trades without human approval.**",
            ].join("\n"),
          },
        },
      ],
    }),
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // TOOLS — Polymarket data & research intelligence
  // ═══════════════════════════════════════════════════════════════════════════

  // ─── Setup ────────────────────────────────────────────────────────────────

  server.tool(
    "setup",
    `Set up the PolyDesk trading desk in Notion. Call this when user says "setup", "set up", "create trading desk", "initialize", or "start".

This tool returns step-by-step instructions. Execute them using the Notion MCP tools (API-post-page, API-patch-block-children, etc.) and PolyDesk tools (scan_trending_markets, format_watchlist_entry).`,
    {
      market_count: z.number().min(1).max(20).default(10).describe("Number of trending markets to populate"),
    },
    async ({ market_count }) => {
      // Fetch live trending markets
      const markets = await getTrendingMarkets(market_count);
      const marketSummaries = markets.map((m, i) => {
        const outcomes = parseOutcomes(m);
        const yp = yesPrice(m);
        return `${i + 1}. "${truncate(m.question, 80)}" | ID: ${m.id} | Yes: ${(yp * 100).toFixed(1)}% | Vol: ${formatVolume(num(m.volume))}`;
      });

      return {
        content: [
          {
            type: "text",
            text: [
              "# PolyDesk Setup — Execute These Steps",
              "",
              "Use ENGLISH for all content. Execute each step using Notion MCP tools.",
              "",
              "## Step 1: Create Main Page",
              "Use API-post-page to create a page in your workspace:",
              "- Title: 'PolyDesk Trading Desk'",
              "- Icon: 📊",
              "",
              "Then use API-patch-block-children to add:",
              "- callout (icon: 🚀, blue_background): 'AI-powered prediction market research & trading control plane. Powered by Polymarket + Karpathy autoresearch ratchet.'",
              "- divider",
              "- callout (icon: 🔒, green_background): 'Human-in-the-loop: AI researches → you review → only approved trades proceed.'",
              "- divider",
              "",
              "## Step 2: Create Watchlist Database",
              "Use API-post-page with parent = the main page to create an INLINE DATABASE titled 'Market Watchlist' (icon: 👁️).",
              "Properties (create_database is not available, so create a database via API-post-page if possible, OR create a table block):",
              "",
              "Use the polydesk://schemas/notion-databases resource for the full schema with these columns:",
              "Market (title), Market ID (rich_text), Yes Price (number/percent), No Price (number/percent), Volume (number/dollar), Signal (select), Fair Value (number/percent), Edge (number/percent), Research Status (select), Human Approval (select)",
              "",
              "## Step 3: Populate with Live Markets",
              `Add these ${markets.length} trending markets as rows. For each, call \`format_watchlist_entry\` with the market_id to get exact Notion properties, then use API-post-page to add the row.`,
              "",
              "Trending markets right now:",
              ...marketSummaries,
              "",
              "## Step 4: Create Research Reports Database",
              "Create another inline database titled 'Research Reports' (icon: 🔬) under the main page.",
              "Use the research schema from polydesk://schemas/notion-databases.",
              "",
              "## Step 5: Done",
              "Report the database IDs and tell the user:",
              "'Your trading desk is ready! You can now:'",
              "'- Check the 🔬 Research checkbox on any market row, then tell me \"sync\" — AI research will run automatically'",
              "'- Type a keyword (like Trump, Bitcoin) in a new row title, then \"sync\" — I will find the matching market'",
              "'- Review research reports and set Human Approval to Approved/Rejected'",
              "'- Tell me \"sync\" anytime to process all changes at once'",
            ].join("\n"),
          },
        ],
      };
    },
  );

  // ─── Market Discovery ─────────────────────────────────────────────────────

  server.tool(
    "scan_trending_markets",
    "Fetch the hottest active Polymarket markets ranked by volume. Use this to discover trading opportunities.",
    {
      limit: z
        .number()
        .min(1)
        .max(50)
        .default(20)
        .describe("Number of markets to return (default 20)"),
    },
    async ({ limit }) => {
      const markets = await getTrendingMarkets(limit);
      const lines = markets.map((m, i) => formatMarketOneLiner(m, i));
      return {
        content: [
          {
            type: "text",
            text: [
              `## Trending Polymarket Markets (Top ${markets.length})`,
              "",
              ...lines,
              "",
              "---",
              "Next steps:",
              "- `get_market` for full details on a specific market",
              "- `auto_research_market` to run the research pipeline",
              "- Use the Notion MCP to add interesting markets to your Watchlist",
            ].join("\n"),
          },
        ],
      };
    },
  );

  server.tool(
    "search_markets",
    "Search Polymarket for markets matching a keyword (e.g., 'bitcoin', 'trump', 'fed', 'election').",
    {
      query: z.string().describe("Search keyword"),
      limit: z.number().min(1).max(30).default(10).describe("Max results"),
    },
    async ({ query, limit }) => {
      const markets = await searchMarkets(query, limit);
      if (markets.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `No active markets found for "${query}". Try broader terms or check spelling.`,
            },
          ],
        };
      }
      const lines = markets.map((m, i) => formatMarketOneLiner(m, i));
      return {
        content: [
          {
            type: "text",
            text: [
              `## Search: "${query}" — ${markets.length} result(s)`,
              "",
              ...lines,
            ].join("\n"),
          },
        ],
      };
    },
  );

  server.tool(
    "get_market",
    "Get full details for a Polymarket market: description, outcomes, prices, volume, liquidity.",
    {
      market_id: z.string().describe("Polymarket market ID (condition_id or slug)"),
    },
    async ({ market_id }) => {
      const m = await getMarketById(market_id);
      return {
        content: [{ type: "text", text: formatMarketFull(m) }],
      };
    },
  );

  server.tool(
    "get_events",
    "Fetch top Polymarket events (event = group of related markets). Great for finding multi-market opportunities.",
    {
      limit: z.number().min(1).max(20).default(10).describe("Number of events"),
    },
    async ({ limit }) => {
      const events = await getEvents(limit);
      const lines = events.map((ev, i) => {
        const marketCount = ev.markets?.length ?? 0;
        return [
          `${i + 1}. **${ev.title}**`,
          `   ID: \`${ev.id}\` | ${marketCount} market(s) | Vol: ${formatVolume(num(ev.volume))}`,
          ...(ev.markets ?? []).slice(0, 3).map((m) => {
            const top = parseOutcomes(m).sort((a, b) => b.price - a.price)[0];
            return `   → ${m.question}${top ? ` — ${top.name} @ ${top.impliedProb}` : ""}`;
          }),
        ].join("\n");
      });
      return {
        content: [
          {
            type: "text",
            text: [`## Top Events (${events.length})`, "", ...lines].join(
              "\n\n",
            ),
          },
        ],
      };
    },
  );

  server.tool(
    "get_event",
    "Get full details for a Polymarket event and all its markets.",
    {
      event_id: z.string().describe("Polymarket event ID"),
    },
    async ({ event_id }) => {
      const ev = await getEventById(event_id);
      const marketDetails = (ev.markets ?? []).map((m, i) => {
        const outcomes = parseOutcomes(m);
        const outcomeStr = outcomes
          .map((o) => `  - ${o.name}: ${o.impliedProb}`)
          .join("\n");
        return [
          `### ${i + 1}. ${m.question}`,
          `ID: \`${m.id}\``,
          `Vol: ${formatVolume(num(m.volume))} | End: ${m.endDate?.split("T")[0] ?? "N/A"}`,
          outcomeStr,
        ].join("\n");
      });
      return {
        content: [
          {
            type: "text",
            text: [
              `# Event: ${ev.title}`,
              `ID: \`${ev.id}\` | Vol: ${formatVolume(num(ev.volume))}`,
              "",
              `## Markets (${ev.markets?.length ?? 0})`,
              "",
              ...marketDetails,
            ].join("\n\n"),
          },
        ],
      };
    },
  );

  // ─── Price Feeds ──────────────────────────────────────────────────────────

  server.tool(
    "get_prices",
    "Get current prices for one or more markets by ID. Use this to refresh watchlist or check positions.",
    {
      market_ids: z
        .array(z.string())
        .min(1)
        .max(20)
        .describe("Array of Polymarket market IDs"),
    },
    async ({ market_ids }) => {
      const results: string[] = [];
      for (const id of market_ids) {
        try {
          const m = await getMarketById(id);
          const outcomes = parseOutcomes(m);
          const outcomeStr = outcomes
            .map((o) => `${o.name}: ${o.impliedProb}`)
            .join(" | ");
          results.push(
            `**${truncate(m.question, 80)}**\n  ID: \`${id}\` | ${outcomeStr} | Vol: ${formatVolume(num(m.volume))}`,
          );
        } catch (err) {
          results.push(`\`${id}\`: Error — ${err}`);
        }
      }
      return {
        content: [
          {
            type: "text",
            text: [`## Live Prices`, "", ...results].join("\n\n"),
          },
        ],
      };
    },
  );

  // ─── Auto Research ────────────────────────────────────────────────────────

  server.tool(
    "auto_research_market",
    "Generate a structured research prompt for a Polymarket market. Inspired by Karpathy's autoresearch — the AI agent should analyze the prompt, form a thesis, then write findings to Notion via the Notion MCP server. Supports iterative ratchet: re-run with higher iteration to refine.",
    {
      market_id: z.string().describe("Polymarket market ID"),
      iteration: z
        .number()
        .min(1)
        .default(1)
        .describe(
          "Research iteration (increment for re-research, like autoresearch ratchet)",
        ),
    },
    async ({ market_id, iteration }) => {
      const m = await getMarketById(market_id);
      const prompt = buildResearchPrompt(m, iteration);
      return {
        content: [{ type: "text", text: prompt }],
      };
    },
  );

  server.tool(
    "research_with_ollama",
    `One-click AI research: fetches market data, calls local Ollama LLM for analysis, and returns both the research results AND formatted Notion blocks ready to write. This is the "Research Button" — call it, then write the output to Notion.

Returns:
1. Research results (conviction, fair value, edge, evidence, risks, analysis)
2. Notion blocks for a beautiful research report page (pass to API-patch-block-children)
3. Watchlist properties (pass to API-post-page or API-patch-page)

Requires Ollama running locally (default: http://localhost:11434).`,
    {
      market_id: z.string().describe("Polymarket market ID"),
      iteration: z.number().min(1).default(1).describe("Research iteration (increment for re-research)"),
    },
    async ({ market_id, iteration }) => {
      const m = await getMarketById(market_id);
      const ollamaPrompt = buildOllamaPrompt(m, iteration);

      // Call Ollama for AI research
      const research = await callOllama(ollamaPrompt);

      // Compute edge
      const currentYesPrice = yesPrice(m);
      const edge = research.fair_value - currentYesPrice;

      const convictionEmoji: Record<string, string> = {
        "Strong Buy": "🟢", "Buy": "🔵", "Hold": "⚪", "Sell": "🟡", "Strong Sell": "🔴",
      };
      const convictionColor: Record<string, string> = {
        "Strong Buy": "green_background", "Buy": "blue_background", "Hold": "gray_background",
        "Sell": "yellow_background", "Strong Sell": "red_background",
      };

      const outcomes = parseOutcomes(m);
      const noPx = outcomes.find((o) => o.name.toLowerCase() === "no")?.price ?? (1 - currentYesPrice);

      // Build Notion blocks for beautiful research page
      const notionBlocks: any[] = [
        {
          object: "block", type: "callout",
          callout: {
            rich_text: [{ type: "text", text: { content: `Signal: ${research.conviction}  |  Confidence: ${research.confidence}  |  Iteration #${iteration}` }, annotations: { bold: true } }],
            icon: { type: "emoji", emoji: convictionEmoji[research.conviction] || "📊" },
            color: convictionColor[research.conviction] || "gray_background",
          },
        },
        { object: "block", type: "divider", divider: {} },
        {
          object: "block", type: "heading_2",
          heading_2: { rich_text: [{ type: "text", text: { content: "📊 Market Overview" } }] },
        },
        {
          object: "block", type: "quote",
          quote: { rich_text: [{ type: "text", text: { content: m.question }, annotations: { bold: true } }], color: "blue_background" },
        },
        {
          object: "block", type: "table",
          table: {
            table_width: 3, has_column_header: true, has_row_header: false,
            children: [
              { type: "table_row", table_row: { cells: [
                [{ type: "text", text: { content: "Outcome" }, annotations: { bold: true } }],
                [{ type: "text", text: { content: "Price" }, annotations: { bold: true } }],
                [{ type: "text", text: { content: "Implied Prob" }, annotations: { bold: true } }],
              ] } },
              ...outcomes.map((o) => ({
                type: "table_row" as const,
                table_row: { cells: [
                  [{ type: "text", text: { content: o.name } }],
                  [{ type: "text", text: { content: `$${o.price.toFixed(3)}` } }],
                  [{ type: "text", text: { content: o.impliedProb } }],
                ] },
              })),
            ],
          },
        },
        {
          object: "block", type: "paragraph",
          paragraph: {
            rich_text: [
              { type: "text", text: { content: "Volume: " }, annotations: { bold: true } },
              { type: "text", text: { content: `${formatVolume(num(m.volume))}` } },
              { type: "text", text: { content: "  |  Liquidity: " }, annotations: { bold: true } },
              { type: "text", text: { content: `${formatVolume(num(m.liquidity))}` } },
              { type: "text", text: { content: "  |  Ends: " }, annotations: { bold: true } },
              { type: "text", text: { content: `${m.endDate?.split("T")[0] ?? "N/A"}` } },
            ],
          },
        },
        { object: "block", type: "divider", divider: {} },
        {
          object: "block", type: "heading_2",
          heading_2: { rich_text: [{ type: "text", text: { content: "🎯 Valuation" } }] },
        },
        {
          object: "block", type: "table",
          table: {
            table_width: 2, has_column_header: false, has_row_header: true,
            children: [
              { type: "table_row", table_row: { cells: [
                [{ type: "text", text: { content: "Market Price" }, annotations: { bold: true } }],
                [{ type: "text", text: { content: `${(currentYesPrice * 100).toFixed(1)}%` } }],
              ] } },
              { type: "table_row", table_row: { cells: [
                [{ type: "text", text: { content: "AI Fair Value" }, annotations: { bold: true } }],
                [{ type: "text", text: { content: `${(research.fair_value * 100).toFixed(1)}%` } }],
              ] } },
              { type: "table_row", table_row: { cells: [
                [{ type: "text", text: { content: "Edge" }, annotations: { bold: true } }],
                [{ type: "text", text: { content: `${edge >= 0 ? "+" : ""}${(edge * 100).toFixed(1)}%` }, annotations: { bold: true, color: edge >= 0 ? "green" : "red" } }],
              ] } },
            ],
          },
        },
        { object: "block", type: "divider", divider: {} },
        {
          object: "block", type: "heading_2",
          heading_2: { rich_text: [{ type: "text", text: { content: "📈 Base Rate" } }] },
        },
        {
          object: "block", type: "callout",
          callout: {
            rich_text: [{ type: "text", text: { content: research.base_rate || "No base rate data available." } }],
            icon: { type: "emoji", emoji: "📉" },
            color: "purple_background",
          },
        },
        {
          object: "block", type: "heading_2",
          heading_2: { rich_text: [{ type: "text", text: { content: "🔍 Key Evidence" } }] },
        },
        ...(research.evidence || []).map((e) => ({
          object: "block", type: "numbered_list_item",
          numbered_list_item: { rich_text: [{ type: "text", text: { content: e } }] },
        })),
        { object: "block", type: "divider", divider: {} },
        {
          object: "block", type: "heading_2",
          heading_2: { rich_text: [{ type: "text", text: { content: "🧠 Analysis" } }] },
        },
        ...(research.analysis || "").split("\n\n").filter(Boolean).map((para) => ({
          object: "block", type: "paragraph",
          paragraph: { rich_text: [{ type: "text", text: { content: para.trim() } }] },
        })),
        { object: "block", type: "divider", divider: {} },
        {
          object: "block", type: "heading_2",
          heading_2: { rich_text: [{ type: "text", text: { content: "⚠️ Risks" } }] },
        },
        ...(research.risks || []).map((r) => ({
          object: "block", type: "bulleted_list_item",
          bulleted_list_item: { rich_text: [{ type: "text", text: { content: r } }], color: "red" as const },
        })),
        { object: "block", type: "divider", divider: {} },
        {
          object: "block", type: "callout",
          callout: {
            rich_text: [
              { type: "text", text: { content: `Generated by PolyDesk MCP + ${OLLAMA_MODEL}  |  ` }, annotations: { italic: true } },
              { type: "text", text: { content: new Date().toISOString().split("T")[0] }, annotations: { italic: true, code: true } },
              { type: "text", text: { content: `  |  Iteration #${iteration}` }, annotations: { italic: true } },
            ],
            icon: { type: "emoji", emoji: "🤖" },
            color: "gray_background",
          },
        },
      ];

      // Build watchlist properties
      const watchlistProps: Record<string, any> = {
        "Market": { title: [{ text: { content: truncate(m.question, 100) } }] },
        "Market ID": { rich_text: [{ text: { content: m.id.toString() } }] },
        "Yes Price": { number: currentYesPrice },
        "No Price": { number: noPx },
        "Volume": { number: num(m.volume) },
        "Liquidity": { number: num(m.liquidity) },
        "Signal": { select: { name: research.conviction } },
        "Fair Value": { number: research.fair_value },
        "Edge": { number: parseFloat(edge.toFixed(4)) },
        "Research Status": { select: { name: "Complete" } },
        "Human Approval": { select: { name: "Pending Review" } },
      };
      if (m.endDate) watchlistProps["End Date"] = { date: { start: m.endDate.split("T")[0] } };

      // Research report properties
      const researchProps: Record<string, any> = {
        "Title": { title: [{ text: { content: `Research: ${truncate(m.question, 80)}` } }] },
        "Market": { rich_text: [{ text: { content: truncate(m.question, 100) } }] },
        "Market ID": { rich_text: [{ text: { content: m.id.toString() } }] },
        "Conviction": { select: { name: research.conviction } },
        "Fair Value": { number: research.fair_value },
        "Market Price": { number: currentYesPrice },
        "Edge": { number: parseFloat(edge.toFixed(4)) },
        "Confidence": { select: { name: research.confidence } },
        "Date": { date: { start: new Date().toISOString().split("T")[0] } },
        "Iteration": { number: iteration },
      };

      return {
        content: [
          {
            type: "text",
            text: [
              `## 🔬 Ollama Research Complete`,
              "",
              `**${m.question}**`,
              `${convictionEmoji[research.conviction] || "📊"} ${research.conviction} | Confidence: ${research.confidence}`,
              `Fair Value: ${(research.fair_value * 100).toFixed(1)}% | Market: ${(currentYesPrice * 100).toFixed(1)}% | Edge: ${edge >= 0 ? "+" : ""}${(edge * 100).toFixed(1)}%`,
              "",
              `Model: ${OLLAMA_MODEL} | Iteration #${iteration}`,
              "",
              "---",
              "",
              "### Write to Notion",
              "Now do these 3 steps:",
              "",
              "**1. Add/update Watchlist row** — API-post-page to Watchlist database:",
              "```json",
              JSON.stringify(watchlistProps, null, 2),
              "```",
              "",
              "**2. Create Research Report page** — API-post-page to Research database:",
              "```json",
              JSON.stringify(researchProps, null, 2),
              "```",
              "",
              "**3. Add beautiful content to the Research page** — API-patch-block-children with the research page ID:",
              "```json",
              JSON.stringify({ children: notionBlocks }, null, 2),
              "```",
            ].join("\n"),
          },
        ],
      };
    },
  );

  server.tool(
    "batch_research",
    "Generate research prompts for multiple trending markets at once. The agent should process each, analyze, and write reports to Notion.",
    {
      limit: z.number().min(1).max(10).default(5).describe("Number of markets to research"),
      min_volume_usd: z
        .number()
        .default(100000)
        .describe("Minimum volume filter in USD"),
    },
    async ({ limit, min_volume_usd }) => {
      const markets = await getTrendingMarkets(50);
      const filtered = markets
        .filter((m) => num(m.volume) >= min_volume_usd)
        .slice(0, limit);

      if (filtered.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `No markets found with volume >= ${formatVolume(min_volume_usd)}. Try lowering the threshold.`,
            },
          ],
        };
      }

      const sections = filtered.map((m, i) => {
        const prompt = buildResearchPrompt(m, 1);
        return [
          `${"=".repeat(60)}`,
          `## Market ${i + 1} of ${filtered.length}`,
          `${"=".repeat(60)}`,
          "",
          prompt,
        ].join("\n");
      });

      return {
        content: [
          {
            type: "text",
            text: [
              `# Batch Auto Research — ${filtered.length} Markets`,
              "",
              "For each market below:",
              "1. Analyze following the research structure",
              "2. Use the Notion MCP to create a Research Report page",
              "3. Use the Notion MCP to add/update the Watchlist entry",
              "",
              ...sections,
            ].join("\n"),
          },
        ],
      };
    },
  );

  // ─── Trade Helpers ────────────────────────────────────────────────────────

  server.tool(
    "calculate_trade",
    "Calculate trade parameters: position sizing, risk/reward ratio, max gain, max loss. Use before logging a trade.",
    {
      market_id: z.string().describe("Polymarket market ID"),
      side: z.enum(["Yes", "No"]).describe("Which outcome to bet on"),
      size_usd: z.number().min(0).describe("Position size in USD"),
      take_profit: z
        .number()
        .min(0)
        .max(1)
        .describe("Take profit price (0-1)"),
      stop_loss: z
        .number()
        .min(0)
        .max(1)
        .describe("Stop loss price (0-1)"),
      fair_value: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe("Your estimated fair value (0-1)"),
    },
    async ({ market_id, side, size_usd, take_profit, stop_loss, fair_value }) => {
      const m = await getMarketById(market_id);
      const outcomes = parseOutcomes(m);
      const currentPrice =
        side === "Yes"
          ? (outcomes.find((o) => o.name.toLowerCase() === "yes")?.price ??
            outcomes[0]?.price ??
            0)
          : (outcomes.find((o) => o.name.toLowerCase() === "no")?.price ??
            outcomes[1]?.price ??
            0);

      const shares = size_usd / currentPrice;
      const maxGain = shares * Math.abs(take_profit - currentPrice);
      const maxLoss = shares * Math.abs(currentPrice - stop_loss);
      const rr = maxLoss > 0 ? maxGain / maxLoss : Infinity;
      const edge =
        fair_value !== undefined ? fair_value - currentPrice : undefined;
      const kellyFraction =
        fair_value !== undefined && fair_value > 0
          ? (fair_value * (1 / currentPrice - 1) - (1 - fair_value)) /
            (1 / currentPrice - 1)
          : undefined;

      return {
        content: [
          {
            type: "text",
            text: [
              `## Trade Calculator`,
              "",
              `**${m.question}**`,
              `Side: ${side} | Current: ${(currentPrice * 100).toFixed(1)}%`,
              "",
              `| Parameter | Value |`,
              `|-----------|-------|`,
              `| Entry Price | ${(currentPrice * 100).toFixed(1)}% |`,
              `| Take Profit | ${(take_profit * 100).toFixed(1)}% |`,
              `| Stop Loss | ${(stop_loss * 100).toFixed(1)}% |`,
              `| Size | $${size_usd.toFixed(2)} |`,
              `| Shares | ${shares.toFixed(2)} |`,
              `| Max Gain | $${maxGain.toFixed(2)} |`,
              `| Max Loss | $${maxLoss.toFixed(2)} |`,
              `| Risk/Reward | ${rr.toFixed(2)}x |`,
              edge !== undefined
                ? `| Edge | ${(edge * 100).toFixed(1)}% |`
                : "",
              kellyFraction !== undefined
                ? `| Kelly % | ${(Math.max(0, kellyFraction) * 100).toFixed(1)}% |`
                : "",
              "",
              rr < 1.5
                ? "⚠️ R:R below 1.5 — consider widening take profit or tightening stop loss."
                : rr >= 3
                  ? "✅ Excellent R:R ratio."
                  : "📊 Acceptable R:R ratio.",
              edge !== undefined && edge < 0
                ? "⚠️ Negative edge — the market price is already above your fair value."
                : "",
              kellyFraction !== undefined && kellyFraction > 0.25
                ? "⚠️ Kelly suggests >25% allocation — consider fractional Kelly (half or quarter)."
                : "",
              "",
              "When ready, use the Notion MCP to create a Trade Journal entry.",
            ]
              .filter(Boolean)
              .join("\n"),
          },
        ],
      };
    },
  );

  server.tool(
    "check_positions",
    "Fetch current prices for a list of market IDs and calculate P&L against entry prices. Use this to update the Notion Trade Journal.",
    {
      positions: z
        .array(
          z.object({
            market_id: z.string().describe("Polymarket market ID"),
            side: z.enum(["Yes", "No"]).describe("Trade side"),
            entry_price: z.number().describe("Entry price (0-1)"),
            size_usd: z.number().describe("Position size in USD"),
          }),
        )
        .min(1)
        .max(20)
        .describe("Array of open positions to check"),
    },
    async ({ positions }) => {
      const results: string[] = [];
      let totalPnl = 0;
      let totalSize = 0;

      for (const pos of positions) {
        try {
          const m = await getMarketById(pos.market_id);
          const outcomes = parseOutcomes(m);
          const currentPrice =
            pos.side === "Yes"
              ? (outcomes.find((o) => o.name.toLowerCase() === "yes")?.price ??
                outcomes[0]?.price ??
                0)
              : (outcomes.find((o) => o.name.toLowerCase() === "no")?.price ??
                outcomes[1]?.price ??
                0);

          const pnlPct =
            pos.entry_price > 0
              ? (currentPrice - pos.entry_price) / pos.entry_price
              : 0;
          const pnlUsd = pos.size_usd * pnlPct;
          totalPnl += pnlUsd;
          totalSize += pos.size_usd;

          const emoji = pnlUsd >= 0 ? "🟢" : "🔴";
          results.push(
            [
              `${emoji} **${truncate(m.question, 60)}**`,
              `  ${pos.side} @ ${(pos.entry_price * 100).toFixed(1)}% → ${(currentPrice * 100).toFixed(1)}%`,
              `  P&L: ${pnlUsd >= 0 ? "+" : ""}$${pnlUsd.toFixed(2)} (${pnlPct >= 0 ? "+" : ""}${(pnlPct * 100).toFixed(1)}%)`,
              `  Size: $${pos.size_usd} | Market ID: \`${pos.market_id}\``,
            ].join("\n"),
          );
        } catch (err) {
          results.push(
            `⚠️ \`${pos.market_id}\`: Failed to fetch — ${err}`,
          );
        }
      }

      return {
        content: [
          {
            type: "text",
            text: [
              `## Portfolio Check — ${positions.length} Position(s)`,
              "",
              ...results,
              "",
              "---",
              `**Total P&L: ${totalPnl >= 0 ? "+" : ""}$${totalPnl.toFixed(2)}**`,
              `**Total Exposure: $${totalSize.toFixed(2)}**`,
              `**Return: ${totalSize > 0 ? `${((totalPnl / totalSize) * 100).toFixed(2)}%` : "N/A"}**`,
              "",
              "Use the Notion MCP to update each Trade Journal entry with the current prices and P&L.",
            ].join("\n"),
          },
        ],
      };
    },
  );

  // ─── Market Analysis Utilities ────────────────────────────────────────────

  server.tool(
    "compare_markets",
    "Compare odds across multiple markets side by side. Useful for finding relative value or arbitrage opportunities.",
    {
      market_ids: z
        .array(z.string())
        .min(2)
        .max(10)
        .describe("Market IDs to compare"),
    },
    async ({ market_ids }) => {
      const markets: { market: PolyMarket; outcomes: ReturnType<typeof parseOutcomes> }[] = [];
      for (const id of market_ids) {
        try {
          const m = await getMarketById(id);
          markets.push({ market: m, outcomes: parseOutcomes(m) });
        } catch (err) {
          markets.push({
            market: { id, question: `Error: ${err}` } as PolyMarket,
            outcomes: [],
          });
        }
      }

      const rows = markets.map(({ market: m, outcomes }) => {
        const top = outcomes.sort((a, b) => b.price - a.price)[0];
        return [
          `| ${truncate(m.question, 50)} | ${top?.name ?? "?"} @ ${top?.impliedProb ?? "?"} | ${formatVolume(num(m.volume))} | ${m.endDate?.split("T")[0] ?? "?"} |`,
        ].join("");
      });

      return {
        content: [
          {
            type: "text",
            text: [
              `## Market Comparison`,
              "",
              `| Market | Leading Outcome | Volume | End Date |`,
              `|--------|----------------|--------|----------|`,
              ...rows,
              "",
              "---",
              "Look for:",
              "- Similar markets with different odds → relative value",
              "- Markets in the same event with correlated outcomes → hedging",
              "- High volume + wide spread → liquidity opportunity",
            ].join("\n"),
          },
        ],
      };
    },
  );

  server.tool(
    "edge_scanner",
    "Scan trending markets and flag those where simple heuristics suggest potential mispricing. A quick filter before deep research.",
    {
      limit: z.number().min(5).max(50).default(30).describe("Markets to scan"),
    },
    async ({ limit }) => {
      const markets = await getTrendingMarkets(limit);
      const flags: string[] = [];

      for (const m of markets) {
        const outcomes = parseOutcomes(m);
        if (outcomes.length < 2) continue;

        const sorted = outcomes.sort((a, b) => b.price - a.price);
        const totalProb = outcomes.reduce((s, o) => s + o.price, 0);
        const overround = totalProb - 1;
        const yesPx = yesPrice(m);

        const flagReasons: string[] = [];

        // High overround = possible inefficiency
        if (overround > 0.05) {
          flagReasons.push(
            `Overround: ${(overround * 100).toFixed(1)}% (prices sum to ${(totalProb * 100).toFixed(1)}%)`,
          );
        }

        // Extreme odds that might reflect narrative bias
        if (yesPx > 0.9 || yesPx < 0.1) {
          flagReasons.push(
            `Extreme odds: Yes @ ${(yesPx * 100).toFixed(1)}% — check for overconfidence`,
          );
        }

        // High volume low liquidity = possible information asymmetry
        const vol = num(m.volume);
        const liq = num(m.liquidity);
        if (vol > 0 && liq > 0 && vol / liq > 50) {
          flagReasons.push(
            `Vol/Liq ratio: ${(vol / liq).toFixed(0)}x — possible information asymmetry`,
          );
        }

        if (flagReasons.length > 0) {
          flags.push(
            [
              `**${m.question}**`,
              `  ID: \`${m.id}\` | ${sorted[0].name}: ${sorted[0].impliedProb} | Vol: ${formatVolume(num(m.volume))}`,
              ...flagReasons.map((r) => `  ⚡ ${r}`),
            ].join("\n"),
          );
        }
      }

      return {
        content: [
          {
            type: "text",
            text: [
              `## Edge Scanner — ${flags.length} flag(s) from ${markets.length} markets`,
              "",
              flags.length === 0
                ? "No obvious flags found. Markets look efficiently priced. Try `auto_research_market` for deeper analysis."
                : flags.join("\n\n"),
              "",
              "---",
              "Flags are heuristic only — use `auto_research_market` for proper analysis before trading.",
            ].join("\n"),
          },
        ],
      };
    },
  );

  // ─── Human-in-the-Loop Tools ───────────────────────────────────────────

  server.tool(
    "generate_execution_plan",
    "Given a list of human-approved markets with fair values, generate a portfolio execution plan with position sizing (Kelly criterion), risk limits, and correlation checks. Use after reading human approvals from Notion.",
    {
      approved_markets: z
        .array(
          z.object({
            market_id: z.string().describe("Polymarket market ID"),
            side: z.enum(["Yes", "No"]).describe("Which side to trade"),
            human_fair_value: z.number().min(0).max(1).describe("Human-approved fair value"),
            max_size_usd: z.number().min(0).default(100).describe("Max position size in USD"),
          }),
        )
        .min(1)
        .max(10)
        .describe("Markets approved by the human for trading"),
      total_bankroll: z
        .number()
        .min(0)
        .default(1000)
        .describe("Total bankroll in USD"),
      max_portfolio_risk: z
        .number()
        .min(0)
        .max(1)
        .default(0.2)
        .describe("Max fraction of bankroll at risk (default 20%)"),
    },
    async ({ approved_markets, total_bankroll, max_portfolio_risk }) => {
      const plans: string[] = [];
      let totalAllocation = 0;

      for (const am of approved_markets) {
        try {
          const m = await getMarketById(am.market_id);
          const outcomes = parseOutcomes(m);
          const currentPrice =
            am.side === "Yes"
              ? (outcomes.find((o) => o.name.toLowerCase() === "yes")?.price ?? outcomes[0]?.price ?? 0)
              : (outcomes.find((o) => o.name.toLowerCase() === "no")?.price ?? outcomes[1]?.price ?? 0);

          const edge = am.human_fair_value - currentPrice;
          const kellyFull =
            currentPrice > 0
              ? (am.human_fair_value * (1 / currentPrice - 1) - (1 - am.human_fair_value)) / (1 / currentPrice - 1)
              : 0;
          const kellyHalf = Math.max(0, kellyFull * 0.5);
          const kellySize = Math.min(
            kellyHalf * total_bankroll,
            am.max_size_usd,
            total_bankroll * max_portfolio_risk - totalAllocation,
          );
          const finalSize = Math.max(0, parseFloat(kellySize.toFixed(2)));
          totalAllocation += finalSize;

          const rr = edge > 0 ? (1 - currentPrice) / currentPrice : 0;

          plans.push(
            [
              `### ${am.side} — ${truncate(m.question, 60)}`,
              `| Field | Value |`,
              `|-------|-------|`,
              `| Market ID | \`${am.market_id}\` |`,
              `| Current Price | ${(currentPrice * 100).toFixed(1)}% |`,
              `| Human Fair Value | ${(am.human_fair_value * 100).toFixed(1)}% |`,
              `| Edge | ${(edge * 100).toFixed(1)}% |`,
              `| Kelly (full) | ${(kellyFull * 100).toFixed(1)}% |`,
              `| Kelly (half) | ${(kellyHalf * 100).toFixed(1)}% |`,
              `| Position Size | $${finalSize.toFixed(2)} |`,
              `| R:R | ${rr.toFixed(2)}x |`,
              edge <= 0 ? `| **WARNING** | Negative edge — human approved but price moved |` : "",
            ].filter(Boolean).join("\n"),
          );
        } catch (err) {
          plans.push(`### Error: \`${am.market_id}\` — ${err}`);
        }
      }

      return {
        content: [
          {
            type: "text",
            text: [
              `# Execution Plan — ${approved_markets.length} Approved Trade(s)`,
              "",
              `**Bankroll:** $${total_bankroll} | **Max Risk:** ${(max_portfolio_risk * 100).toFixed(0)}% | **Total Allocated:** $${totalAllocation.toFixed(2)} (${((totalAllocation / total_bankroll) * 100).toFixed(1)}%)`,
              "",
              ...plans,
              "",
              "---",
              "## Next Steps",
              "1. Review this plan",
              "2. Use the Notion MCP to create Trade Journal entries for each position",
              "3. Set each Trade Journal entry Status = 'Open'",
              "",
              totalAllocation > total_bankroll * max_portfolio_risk
                ? "**WARNING: Total allocation exceeds risk limit. Some positions were reduced.**"
                : "",
            ].filter(Boolean).join("\n"),
          },
        ],
      };
    },
  );

  server.tool(
    "format_research_for_notion",
    `Generate beautiful, rich Notion page content blocks for a market research report. Returns the exact Notion API block structure — pass it directly to the Notion MCP's API-patch-block-children tool to create a stunning research page.

Workflow:
1. First create a page in your Research database using API-post-page
2. Then call this tool to get the formatted blocks
3. Pass the blocks to API-patch-block-children with the page ID`,
    {
      market_id: z.string().describe("Polymarket market ID"),
      conviction: z.enum(["Strong Buy", "Buy", "Hold", "Sell", "Strong Sell"]).describe("Your research conviction"),
      fair_value: z.number().min(0).max(1).describe("Your estimated fair probability (0-1)"),
      confidence: z.enum(["High", "Medium", "Low"]).describe("Confidence level"),
      base_rate: z.string().describe("1-2 sentences on historical base rate"),
      evidence: z.array(z.string()).min(1).max(6).describe("Key evidence points"),
      risks: z.array(z.string()).min(1).max(4).describe("Risk factors"),
      analysis: z.string().describe("2-3 paragraph analysis"),
      iteration: z.number().min(1).default(1).describe("Research iteration number"),
    },
    async ({ market_id, conviction, fair_value, confidence, base_rate, evidence, risks, analysis, iteration }) => {
      const m = await getMarketById(market_id);
      const outcomes = parseOutcomes(m);
      const currentYesPrice = yesPrice(m);
      const edge = fair_value - currentYesPrice;
      const vol = num(m.volume);
      const liq = num(m.liquidity);

      const convictionColor: Record<string, string> = {
        "Strong Buy": "green_background",
        "Buy": "blue_background",
        "Hold": "gray_background",
        "Sell": "yellow_background",
        "Strong Sell": "red_background",
      };
      const convictionEmoji: Record<string, string> = {
        "Strong Buy": "🟢",
        "Buy": "🔵",
        "Hold": "⚪",
        "Sell": "🟡",
        "Strong Sell": "🔴",
      };

      // Build Notion blocks for a beautiful research page
      const blocks: any[] = [
        // ── Header callout with conviction
        {
          object: "block",
          type: "callout",
          callout: {
            rich_text: [
              { type: "text", text: { content: `Signal: ${conviction}  |  Confidence: ${confidence}  |  Iteration #${iteration}` }, annotations: { bold: true } },
            ],
            icon: { type: "emoji", emoji: convictionEmoji[conviction] || "📊" },
            color: convictionColor[conviction] || "gray_background",
          },
        },
        // ── Divider
        { object: "block", type: "divider", divider: {} },
        // ── Market Question
        {
          object: "block",
          type: "heading_2",
          heading_2: {
            rich_text: [{ type: "text", text: { content: "📊 Market Overview" } }],
          },
        },
        {
          object: "block",
          type: "quote",
          quote: {
            rich_text: [{ type: "text", text: { content: m.question }, annotations: { bold: true } }],
            color: "blue_background",
          },
        },
        // ── Outcomes table
        {
          object: "block",
          type: "table",
          table: {
            table_width: 3,
            has_column_header: true,
            has_row_header: false,
            children: [
              {
                type: "table_row",
                table_row: {
                  cells: [
                    [{ type: "text", text: { content: "Outcome" }, annotations: { bold: true } }],
                    [{ type: "text", text: { content: "Price" }, annotations: { bold: true } }],
                    [{ type: "text", text: { content: "Implied Prob" }, annotations: { bold: true } }],
                  ],
                },
              },
              ...outcomes.map((o) => ({
                type: "table_row" as const,
                table_row: {
                  cells: [
                    [{ type: "text", text: { content: o.name } }],
                    [{ type: "text", text: { content: `$${o.price.toFixed(3)}` } }],
                    [{ type: "text", text: { content: o.impliedProb } }],
                  ],
                },
              })),
            ],
          },
        },
        // ── Stats
        {
          object: "block",
          type: "paragraph",
          paragraph: {
            rich_text: [
              { type: "text", text: { content: "Volume: " }, annotations: { bold: true } },
              { type: "text", text: { content: `${formatVolume(vol)}` } },
              { type: "text", text: { content: "  |  Liquidity: " }, annotations: { bold: true } },
              { type: "text", text: { content: `${formatVolume(liq)}` } },
              { type: "text", text: { content: "  |  Ends: " }, annotations: { bold: true } },
              { type: "text", text: { content: `${m.endDate?.split("T")[0] ?? "N/A"}` } },
            ],
          },
        },
        { object: "block", type: "divider", divider: {} },
        // ── Valuation Section
        {
          object: "block",
          type: "heading_2",
          heading_2: {
            rich_text: [{ type: "text", text: { content: "🎯 Valuation" } }],
          },
        },
        {
          object: "block",
          type: "table",
          table: {
            table_width: 2,
            has_column_header: false,
            has_row_header: true,
            children: [
              {
                type: "table_row",
                table_row: {
                  cells: [
                    [{ type: "text", text: { content: "Market Price" }, annotations: { bold: true } }],
                    [{ type: "text", text: { content: `${(currentYesPrice * 100).toFixed(1)}%` } }],
                  ],
                },
              },
              {
                type: "table_row",
                table_row: {
                  cells: [
                    [{ type: "text", text: { content: "Fair Value (AI)" }, annotations: { bold: true } }],
                    [{ type: "text", text: { content: `${(fair_value * 100).toFixed(1)}%` } }],
                  ],
                },
              },
              {
                type: "table_row",
                table_row: {
                  cells: [
                    [{ type: "text", text: { content: "Edge" }, annotations: { bold: true } }],
                    [{ type: "text", text: { content: `${edge >= 0 ? "+" : ""}${(edge * 100).toFixed(1)}%` }, annotations: { bold: true, color: edge >= 0 ? "green" : "red" } }],
                  ],
                },
              },
            ],
          },
        },
        { object: "block", type: "divider", divider: {} },
        // ── Base Rate
        {
          object: "block",
          type: "heading_2",
          heading_2: {
            rich_text: [{ type: "text", text: { content: "📈 Base Rate Analysis" } }],
          },
        },
        {
          object: "block",
          type: "callout",
          callout: {
            rich_text: [{ type: "text", text: { content: base_rate } }],
            icon: { type: "emoji", emoji: "📉" },
            color: "purple_background",
          },
        },
        // ── Evidence
        {
          object: "block",
          type: "heading_2",
          heading_2: {
            rich_text: [{ type: "text", text: { content: "🔍 Key Evidence" } }],
          },
        },
        ...evidence.map((e, i) => ({
          object: "block",
          type: "numbered_list_item",
          numbered_list_item: {
            rich_text: [{ type: "text", text: { content: e } }],
            color: "default",
          },
        })),
        { object: "block", type: "divider", divider: {} },
        // ── Analysis
        {
          object: "block",
          type: "heading_2",
          heading_2: {
            rich_text: [{ type: "text", text: { content: "🧠 Analysis" } }],
          },
        },
        // Split analysis into paragraphs
        ...analysis.split("\n\n").filter(Boolean).map((para) => ({
          object: "block",
          type: "paragraph",
          paragraph: {
            rich_text: [{ type: "text", text: { content: para.trim() } }],
          },
        })),
        { object: "block", type: "divider", divider: {} },
        // ── Risks
        {
          object: "block",
          type: "heading_2",
          heading_2: {
            rich_text: [{ type: "text", text: { content: "⚠️ Risk Factors" } }],
          },
        },
        ...risks.map((r) => ({
          object: "block",
          type: "bulleted_list_item",
          bulleted_list_item: {
            rich_text: [{ type: "text", text: { content: r } }],
            color: "red",
          },
        })),
        { object: "block", type: "divider", divider: {} },
        // ── Footer
        {
          object: "block",
          type: "callout",
          callout: {
            rich_text: [
              { type: "text", text: { content: `Research generated by PolyDesk MCP  |  ` }, annotations: { italic: true } },
              { type: "text", text: { content: `${new Date().toISOString().split("T")[0]}` }, annotations: { italic: true, code: true } },
              { type: "text", text: { content: `  |  Iteration #${iteration}  |  Autoresearch Ratchet Pattern` }, annotations: { italic: true } },
            ],
            icon: { type: "emoji", emoji: "🤖" },
            color: "gray_background",
          },
        },
      ];

      return {
        content: [
          {
            type: "text",
            text: [
              `## Notion Research Page Content Ready`,
              "",
              `Market: **${m.question}**`,
              `Signal: ${convictionEmoji[conviction]} ${conviction} | Edge: ${edge >= 0 ? "+" : ""}${(edge * 100).toFixed(1)}%`,
              "",
              `### How to use:`,
              `1. Create a page in your Research database with API-post-page`,
              `2. Use API-patch-block-children with the block_id = the new page ID`,
              `3. Pass the children array below as the body`,
              "",
              "### Notion Blocks (pass to API-patch-block-children):",
              "",
              "```json",
              JSON.stringify({ children: blocks }, null, 2),
              "```",
            ].join("\n"),
          },
        ],
      };
    },
  );

  server.tool(
    "format_watchlist_entry",
    `Generate the properties object for adding a market to the Notion Watchlist database. Returns the exact Notion API properties structure — pass it to the Notion MCP's API-post-page tool.`,
    {
      market_id: z.string().describe("Polymarket market ID"),
      conviction: z.enum(["Strong Buy", "Buy", "Hold", "Sell", "Strong Sell"]).default("Hold").describe("AI signal"),
      fair_value: z.number().min(0).max(1).optional().describe("AI estimated fair value"),
      category: z.enum(["Politics", "Crypto", "Sports", "Science", "Culture", "Business", "Other"]).default("Other").describe("Market category"),
    },
    async ({ market_id, conviction, fair_value, category }) => {
      const m = await getMarketById(market_id);
      const outcomes = parseOutcomes(m);
      const yesPx = yesPrice(m);
      const noPx = outcomes.find((o) => o.name.toLowerCase() === "no")?.price ?? (1 - yesPx);
      const edge = fair_value !== undefined ? fair_value - yesPx : undefined;

      const properties: Record<string, any> = {
        "Market": { title: [{ text: { content: truncate(m.question, 100) } }] },
        "Market ID": { rich_text: [{ text: { content: m.id.toString() } }] },
        "Category": { select: { name: category } },
        "Yes Price": { number: yesPx },
        "No Price": { number: noPx },
        "Volume": { number: num(m.volume) },
        "Liquidity": { number: num(m.liquidity) },
        "Signal": { select: { name: conviction } },
        "Research Status": { select: { name: "Complete" } },
        "Human Approval": { select: { name: "Pending Review" } },
      };

      if (m.endDate) {
        properties["End Date"] = { date: { start: m.endDate.split("T")[0] } };
      }
      if (fair_value !== undefined) {
        properties["Fair Value"] = { number: fair_value };
      }
      if (edge !== undefined) {
        properties["Edge"] = { number: parseFloat(edge.toFixed(4)) };
      }

      return {
        content: [
          {
            type: "text",
            text: [
              `## Watchlist Entry Ready`,
              "",
              `Market: **${m.question}**`,
              `Signal: ${conviction} | Yes: ${(yesPx * 100).toFixed(1)}%${fair_value !== undefined ? ` | FV: ${(fair_value * 100).toFixed(1)}% | Edge: ${edge! >= 0 ? "+" : ""}${(edge! * 100).toFixed(1)}%` : ""}`,
              "",
              `### How to use:`,
              `Call API-post-page with:`,
              `- parent: { database_id: "<your watchlist database ID>" }`,
              `- properties: (see below)`,
              "",
              "### Properties (pass to API-post-page):",
              "",
              "```json",
              JSON.stringify(properties, null, 2),
              "```",
            ].join("\n"),
          },
        ],
      };
    },
  );

  server.tool(
    "validate_human_overrides",
    "Check if human fair value overrides are reasonable by comparing against market data and flagging potential errors. Use before executing approved trades.",
    {
      overrides: z
        .array(
          z.object({
            market_id: z.string().describe("Polymarket market ID"),
            human_fair_value: z.number().min(0).max(1).describe("Human-set fair value"),
            ai_fair_value: z.number().min(0).max(1).describe("AI-estimated fair value"),
          }),
        )
        .min(1)
        .max(10),
    },
    async ({ overrides }) => {
      const checks: string[] = [];

      for (const ov of overrides) {
        const flags: string[] = [];
        try {
          const m = await getMarketById(ov.market_id);
          const currentPrice = yesPrice(m);
          const humanEdge = ov.human_fair_value - currentPrice;
          const aiEdge = ov.ai_fair_value - currentPrice;
          const divergence = Math.abs(ov.human_fair_value - ov.ai_fair_value);

          if (divergence > 0.2) {
            flags.push(`Large human-AI divergence: ${(divergence * 100).toFixed(1)}% — verify reasoning`);
          }
          if (ov.human_fair_value > 0.95 || ov.human_fair_value < 0.05) {
            flags.push(`Extreme fair value (${(ov.human_fair_value * 100).toFixed(1)}%) — very high conviction needed`);
          }
          if (humanEdge < 0) {
            flags.push(`Negative edge at current price — market moved since analysis?`);
          }
          if (humanEdge > 0.3) {
            flags.push(`Edge > 30% — unusually large, double-check`);
          }

          const status = flags.length === 0 ? "PASS" : "FLAG";
          checks.push(
            [
              `**${truncate(m.question, 60)}** — ${status}`,
              `  Market: ${(currentPrice * 100).toFixed(1)}% | AI: ${(ov.ai_fair_value * 100).toFixed(1)}% | Human: ${(ov.human_fair_value * 100).toFixed(1)}%`,
              ...flags.map((f) => `  ⚠️ ${f}`),
            ].join("\n"),
          );
        } catch (err) {
          checks.push(`**\`${ov.market_id}\`** — ERROR: ${err}`);
        }
      }

      return {
        content: [
          {
            type: "text",
            text: [
              `## Human Override Validation — ${overrides.length} check(s)`,
              "",
              ...checks,
              "",
              "---",
              "If all checks pass, proceed with `generate_execution_plan`.",
            ].join("\n"),
          },
        ],
      };
    },
  );

  // ─── Notion Bidirectional Sync ──────────────────────────────────────────

  server.tool(
    "sync_notion_watchlist",
    `Bidirectional sync between Notion Watchlist and Polymarket/Ollama. Call this when user says "sync". Reads your Notion Watchlist database and processes changes:

1. **🔬 Research checkbox**: If checked (true), runs Ollama AI research, writes report, then UNCHECKS the box
2. **Keyword → Market**: If a row has a keyword in the Market column but no Market ID, searches Polymarket and populates all data
3. **Approval action**: If Human Approval = "Approved", generates an execution plan
4. **Re-research**: If Human Approval = "Needs More Research", runs research again with iteration+1
5. **Price refresh**: Updates all prices to latest

Example: User types "Trump" in Notion → runs sync → system finds best matching Polymarket market and fills in all data.`,
    {
      watchlist_database_id: z.string().describe("Notion Watchlist database ID"),
      research_database_id: z.string().optional().describe("Notion Research Reports database ID (for writing research pages)"),
      run_research: z.boolean().default(true).describe("Whether to run Ollama research for 'In Progress' rows"),
    },
    async ({ watchlist_database_id, research_database_id, run_research }) => {
      return {
        content: [
          {
            type: "text",
            text: [
              `## Sync Notion Watchlist`,
              "",
              "Execute these steps using the Notion MCP:",
              "",
              "### Step 1: Read All Watchlist Rows",
              `Query database \`${watchlist_database_id}\` using the Notion MCP. Read every row's properties: Market (title), Market ID, 🔬 Research (checkbox), Research Status, Human Approval, Human Fair Value.`,
              "",
              "### Step 2: Process Each Row (in this priority order)",
              "",
              "**A) 🔬 Research checkbox is CHECKED (highest priority):**",
              "The user checked the research checkbox — this is the interactive trigger!",
              run_research
                ? [
                    "1. Get the Market ID from the row",
                    "2. Call PolyDesk `research_with_ollama` with the Market ID",
                    "3. Update the Watchlist row via API-patch-page:",
                    '   - Set Signal, Fair Value, Edge from research results',
                    '   - Set Research Status = "Complete"',
                    '   - **UNCHECK the 🔬 Research checkbox** (set to false) so it can be clicked again',
                    research_database_id
                      ? `4. Create a Research page in database \`${research_database_id}\` with the research properties`
                      : "",
                    research_database_id
                      ? "5. Write the beautiful Notion blocks to that research page via API-patch-block-children"
                      : "",
                  ].filter(Boolean).join("\n")
                : "Skip (run_research = false)",
              "",
              "**B) Keyword → Market (rows with title but empty Market ID):**",
              "The title column contains a search keyword (e.g., 'Trump', 'bitcoin', 'World Cup').",
              "1. Call PolyDesk `search_markets` with that keyword",
              "2. Pick the top result by volume",
              "3. Call `format_watchlist_entry` with that market's ID to get Notion properties",
              "4. Update the row via Notion MCP API-patch-page — fill in Market ID, Yes Price, No Price, Volume, Liquidity, End Date",
              "5. Update the title to the full market question",
              "",
              "**C) Approved (Human Approval = 'Approved' and no trade plan yet):**",
              "1. Read Human Fair Value if set, otherwise use the AI Fair Value",
              "2. Call PolyDesk `calculate_trade` or `generate_execution_plan`",
              "3. Report the trade plan",
              "",
              "**D) Needs More Research (Human Approval = 'Needs More Research'):**",
              "1. Call `research_with_ollama` with iteration = 2",
              "2. Update row and write new research report",
              "3. Set Human Approval back to 'Pending Review'",
              "",
              "**E) All other rows with Market ID (price refresh):**",
              "1. Call PolyDesk `get_market` to refresh prices",
              "2. Update Yes Price, No Price, Volume via API-patch-page",
              "",
              "### Step 3: Report",
              "Summarize: checkboxes processed, keywords matched, markets researched, approvals processed, prices refreshed.",
            ].join("\n"),
          },
        ],
      };
    },
  );

  // ─── Auto-Watch: Polling Notion for checkbox changes ────────────────────

  async function processWatchlist(wDbId: string, rDbId?: string): Promise<string[]> {
    const logs: string[] = [];
    try {
      const rows = await notionQueryDatabase(wDbId);

      for (const row of rows) {
        const pageId = row.id;
        const title = notionGetTitle(row);
        const marketId = notionGetRichText(row, "Market ID");
        const researchChecked = notionGetCheckbox(row, "🔬 Research");
        const approval = notionGetSelect(row, "Human Approval");

        // A) Checkbox checked → run research
        if (researchChecked && marketId) {
          try {
            logs.push(`🔬 Researching: ${title}`);

            // Immediately update Notion to show "Researching..." so user sees feedback
            await notionUpdatePage(pageId, {
              "Research Status": { select: { name: "In Progress" } },
              "Signal": { select: { name: "Researching" } },
            });

            // Call Ollama
            const m = await getMarketById(marketId);
            const ollamaPrompt = buildOllamaPrompt(m, 1);
            const research = await callOllama(ollamaPrompt);
            const currentYesPrice = yesPrice(m);
            const edge = research.fair_value - currentYesPrice;

            // Update watchlist row
            await notionUpdatePage(pageId, {
              "Signal": { select: { name: research.conviction } },
              "Fair Value": { number: research.fair_value },
              "Edge": { number: parseFloat(edge.toFixed(4)) },
              "Research Status": { select: { name: "Complete" } },
              "🔬 Research": { checkbox: false }, // Uncheck!
            });

            // Create research report page if research DB exists
            if (rDbId) {
              const researchPage = await notionCreatePage(rDbId, {
                "Title": { title: [{ text: { content: `Research: ${truncate(m.question, 80)}` } }] },
                "Market": { rich_text: [{ text: { content: truncate(m.question, 100) } }] },
                "Market ID": { rich_text: [{ text: { content: m.id.toString() } }] },
                "Conviction": { select: { name: research.conviction } },
                "Fair Value": { number: research.fair_value },
                "Market Price": { number: currentYesPrice },
                "Edge": { number: parseFloat(edge.toFixed(4)) },
                "Confidence": { select: { name: research.confidence } },
                "Date": { date: { start: new Date().toISOString().split("T")[0] } },
                "Iteration": { number: 1 },
              });

              // Write beautiful blocks
              const convictionEmoji: Record<string, string> = {
                "Strong Buy": "🟢", "Buy": "🔵", "Hold": "⚪", "Sell": "🟡", "Strong Sell": "🔴",
              };
              const convictionColor: Record<string, string> = {
                "Strong Buy": "green_background", "Buy": "blue_background", "Hold": "gray_background",
                "Sell": "yellow_background", "Strong Sell": "red_background",
              };
              const outcomes = parseOutcomes(m);

              const blocks: any[] = [
                {
                  object: "block", type: "callout",
                  callout: {
                    rich_text: [{ type: "text", text: { content: `Signal: ${research.conviction}  |  Confidence: ${research.confidence}` }, annotations: { bold: true } }],
                    icon: { type: "emoji", emoji: convictionEmoji[research.conviction] || "📊" },
                    color: convictionColor[research.conviction] || "gray_background",
                  },
                },
                { object: "block", type: "divider", divider: {} },
                {
                  object: "block", type: "heading_2",
                  heading_2: { rich_text: [{ type: "text", text: { content: "🎯 Valuation" } }] },
                },
                {
                  object: "block", type: "table",
                  table: {
                    table_width: 2, has_column_header: false, has_row_header: true,
                    children: [
                      { type: "table_row", table_row: { cells: [[{ type: "text", text: { content: "Market Price" }, annotations: { bold: true } }], [{ type: "text", text: { content: `${(currentYesPrice * 100).toFixed(1)}%` } }]] } },
                      { type: "table_row", table_row: { cells: [[{ type: "text", text: { content: "AI Fair Value" }, annotations: { bold: true } }], [{ type: "text", text: { content: `${(research.fair_value * 100).toFixed(1)}%` } }]] } },
                      { type: "table_row", table_row: { cells: [[{ type: "text", text: { content: "Edge" }, annotations: { bold: true } }], [{ type: "text", text: { content: `${edge >= 0 ? "+" : ""}${(edge * 100).toFixed(1)}%` }, annotations: { bold: true, color: edge >= 0 ? "green" : "red" } }]] } },
                    ],
                  },
                },
                { object: "block", type: "divider", divider: {} },
                {
                  object: "block", type: "heading_2",
                  heading_2: { rich_text: [{ type: "text", text: { content: "📈 Base Rate" } }] },
                },
                {
                  object: "block", type: "callout",
                  callout: {
                    rich_text: [{ type: "text", text: { content: research.base_rate || "N/A" } }],
                    icon: { type: "emoji", emoji: "📉" }, color: "purple_background",
                  },
                },
                {
                  object: "block", type: "heading_2",
                  heading_2: { rich_text: [{ type: "text", text: { content: "🔍 Key Evidence" } }] },
                },
                ...(research.evidence || []).map((e) => ({
                  object: "block", type: "numbered_list_item",
                  numbered_list_item: { rich_text: [{ type: "text", text: { content: e } }] },
                })),
                { object: "block", type: "divider", divider: {} },
                {
                  object: "block", type: "heading_2",
                  heading_2: { rich_text: [{ type: "text", text: { content: "🧠 Analysis" } }] },
                },
                ...(research.analysis || "").split("\n\n").filter(Boolean).map((para) => ({
                  object: "block", type: "paragraph",
                  paragraph: { rich_text: [{ type: "text", text: { content: para.trim() } }] },
                })),
                { object: "block", type: "divider", divider: {} },
                {
                  object: "block", type: "heading_2",
                  heading_2: { rich_text: [{ type: "text", text: { content: "⚠️ Risks" } }] },
                },
                ...(research.risks || []).map((r) => ({
                  object: "block", type: "bulleted_list_item",
                  bulleted_list_item: { rich_text: [{ type: "text", text: { content: r } }] },
                })),
                { object: "block", type: "divider", divider: {} },
                {
                  object: "block", type: "callout",
                  callout: {
                    rich_text: [{ type: "text", text: { content: `Generated by PolyDesk + ${OLLAMA_MODEL}  |  ${new Date().toISOString().split("T")[0]}` }, annotations: { italic: true } }],
                    icon: { type: "emoji", emoji: "🤖" }, color: "gray_background",
                  },
                },
              ];

              await notionAppendBlocks(researchPage.id, blocks);
              logs.push(`  ✅ Done: ${research.conviction} | Edge: ${edge >= 0 ? "+" : ""}${(edge * 100).toFixed(1)}% | Report written`);
            } else {
              logs.push(`  ✅ Done: ${research.conviction} | Edge: ${edge >= 0 ? "+" : ""}${(edge * 100).toFixed(1)}%`);
            }
          } catch (err) {
            logs.push(`  ❌ Error: ${err}`);
            // Uncheck anyway so it doesn't loop on errors
            try { await notionUpdatePage(pageId, { "🔬 Research": { checkbox: false } }); } catch {}
          }
        }

        // B) Keyword with no Market ID → search
        if (title && !marketId && title.length < 50) {
          try {
            logs.push(`🔍 Searching: "${title}"`);
            const results = await searchMarkets(title, 1);
            if (results.length > 0) {
              const m = results[0];
              const outcomes = parseOutcomes(m);
              const yp = yesPrice(m);
              const np = outcomes.find((o) => o.name.toLowerCase() === "no")?.price ?? (1 - yp);
              const props: Record<string, any> = {
                "Market": { title: [{ text: { content: truncate(m.question, 100) } }] },
                "Market ID": { rich_text: [{ text: { content: m.id.toString() } }] },
                "Yes Price": { number: yp },
                "No Price": { number: np },
                "Volume": { number: num(m.volume) },
                "Liquidity": { number: num(m.liquidity) },
                "Research Status": { select: { name: "Pending" } },
                "Human Approval": { select: { name: "Pending Review" } },
              };
              if (m.endDate) props["End Date"] = { date: { start: m.endDate.split("T")[0] } };
              await notionUpdatePage(pageId, props);
              logs.push(`  ✅ Found: "${m.question}" (ID: ${m.id})`);
            } else {
              logs.push(`  ⚠️ No markets found for "${title}"`);
            }
          } catch (err) {
            logs.push(`  ❌ Error: ${err}`);
          }
        }
      }
    } catch (err) {
      logs.push(`❌ Sync error: ${err}`);
    }
    return logs;
  }

  server.tool(
    "watch",
    `Start auto-watching the Notion Watchlist. Polls every N seconds for checkbox changes and keyword entries. When user checks 🔬 Research in Notion, AI research runs automatically — no need to say "sync".

Requires NOTION_TOKEN env var. Call "unwatch" to stop.`,
    {
      watchlist_database_id: z.string().describe("Notion Watchlist database ID"),
      research_database_id: z.string().optional().describe("Notion Research Reports database ID"),
      interval_seconds: z.number().min(10).max(300).default(30).describe("Polling interval in seconds (default 30)"),
    },
    async ({ watchlist_database_id, research_database_id, interval_seconds }) => {
      if (!NOTION_TOKEN) {
        return {
          content: [{
            type: "text",
            text: "❌ NOTION_TOKEN not set. Add it to the polydesk MCP config in Claude Desktop:\n\n```json\n\"env\": { \"NOTION_TOKEN\": \"ntn_your_token_here\" }\n```",
          }],
        };
      }

      // Stop existing watch if any
      if (watchInterval) {
        clearInterval(watchInterval);
      }

      watchConfig = { watchlistDbId: watchlist_database_id, researchDbId: research_database_id };

      // Start polling
      watchInterval = setInterval(async () => {
        if (!watchConfig) return;
        const logs = await processWatchlist(watchConfig.watchlistDbId, watchConfig.researchDbId);
        if (logs.length > 0) {
          server.server.sendLoggingMessage({
            level: "info",
            data: `[PolyDesk Watch] ${logs.join(" | ")}`,
          });
        }
      }, interval_seconds * 1000);

      // Run once immediately
      const logs = await processWatchlist(watchlist_database_id, research_database_id);

      return {
        content: [{
          type: "text",
          text: [
            `## 👁️ Watching Notion Watchlist`,
            "",
            `Polling every ${interval_seconds}s for changes.`,
            `Database: \`${watchlist_database_id}\``,
            research_database_id ? `Research DB: \`${research_database_id}\`` : "",
            "",
            "**What happens automatically:**",
            "- ☑️ Check 🔬 Research → AI runs Ollama research → writes report → unchecks box",
            "- 📝 Type a keyword → finds matching Polymarket market → fills data",
            "",
            "Call `unwatch` to stop.",
            "",
            logs.length > 0 ? `### Initial scan:\n${logs.join("\n")}` : "No pending actions found.",
          ].filter(Boolean).join("\n"),
        }],
      };
    },
  );

  server.tool(
    "unwatch",
    "Stop auto-watching the Notion Watchlist. Stops the polling loop started by `watch`.",
    {},
    async () => {
      if (watchInterval) {
        clearInterval(watchInterval);
        watchInterval = null;
        watchConfig = null;
        return { content: [{ type: "text", text: "⏹️ Stopped watching Notion Watchlist." }] };
      }
      return { content: [{ type: "text", text: "Not currently watching." }] };
    },
  );

  // ─── Auto-start watching on server boot ──────────────────────────────────

  if (NOTION_TOKEN) {
    // Delay auto-start slightly to let the server finish connecting
    setTimeout(async () => {
      try {
        const dbs = await autoDiscoverDatabases();
        watchConfig = { watchlistDbId: dbs.watchlistId, researchDbId: dbs.researchId };

        watchInterval = setInterval(async () => {
          if (!watchConfig) return;
          try {
            await processWatchlist(watchConfig.watchlistDbId, watchConfig.researchDbId);
          } catch {}
        }, WATCH_INTERVAL_MS);

        server.server.sendLoggingMessage({
          level: "info",
          data: `[PolyDesk] Auto-watch started (every ${WATCH_INTERVAL_MS / 1000}s). Watchlist: ${dbs.watchlistId}${dbs.researchId ? `, Research: ${dbs.researchId}` : ""}`,
        });
      } catch (err) {
        server.server.sendLoggingMessage({
          level: "warning",
          data: `[PolyDesk] Auto-watch not started: ${err}. Use the "setup" tool first, then restart.`,
        });
      }
    }, 3000);
  }

  return server;
}

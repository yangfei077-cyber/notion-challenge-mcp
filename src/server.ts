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
    "Bootstrap the full PolyDesk workspace in Notion. Creates the dashboard page and 3 databases (Watchlist, Research, Journal).",
    () => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: [
              "Set up my PolyDesk trading desk in Notion. Follow these steps using the Notion MCP server:",
              "",
              "1. Create a new page titled 'PolyDesk — Prediction Market Trading Desk' with icon 📊",
              "2. Add this intro text to the page:",
              "   > AI-powered prediction market research and trading control plane.",
              "   > Powered by Polymarket data + Karpathy-inspired auto-research loops.",
              "",
              "3. Create 3 databases under that page. Use these exact schemas:",
              "",
              "### Market Watchlist (icon: 👁️)",
              "Read the `polydesk://schemas/notion-databases` resource for the full schema.",
              "",
              "### Research Reports (icon: 🔬)",
              "Read the `polydesk://schemas/notion-databases` resource for the full schema.",
              "",
              "### Trade Journal (icon: 📒)",
              "Read the `polydesk://schemas/notion-databases` resource for the full schema.",
              "",
              "4. After creating, report back the database IDs so I can use them with other tools.",
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
              "4. For each market, use the Notion MCP to:",
              "   a. Add/update a row in the Watchlist database with current prices and your signal",
              "   b. Create a Research Report page with your full analysis",
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

  // ═══════════════════════════════════════════════════════════════════════════
  // TOOLS — Polymarket data & research intelligence
  // ═══════════════════════════════════════════════════════════════════════════

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

  return server;
}

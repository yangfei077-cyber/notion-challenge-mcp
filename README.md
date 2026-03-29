# PolyDesk — Polymarket AI Research & Trading Control Plane

An MCP server that turns Polymarket prediction markets into a structured research and trading workflow — powered by **Notion MCP** as the dashboard and knowledge base.

Inspired by [Karpathy's autoresearch](https://github.com/karpathy/autoresearch): the AI agent runs iterative research loops on prediction markets, scores them, and writes structured findings to Notion for human review and trade execution.

## Architecture

```
┌──────────────┐     ┌──────────────────┐     ┌──────────────┐
│  Polymarket  │────→│   PolyDesk MCP   │────→│   AI Agent   │
│  Gamma API   │     │  (this server)   │     │ (Claude, etc)│
└──────────────┘     └──────────────────┘     └──────┬───────┘
                                                     │
                                                     ▼
                                              ┌──────────────┐
                                              │  Notion MCP  │
                                              │  (official)  │
                                              └──────┬───────┘
                                                     │
                                                     ▼
                                              ┌──────────────┐
                                              │   Notion     │
                                              │  Workspace   │
                                              │  (Dashboard) │
                                              └──────────────┘
```

**PolyDesk MCP** provides Polymarket data and research intelligence.
**Notion MCP** (official) handles all Notion CRUD operations.
The AI agent orchestrates both to create a full trading control plane.

## Features

### Tools (12 total)

| Tool | Description |
|------|-------------|
| `scan_trending_markets` | Discover hottest markets by volume |
| `search_markets` | Search markets by keyword |
| `get_market` | Full details for a specific market |
| `get_events` | Browse top events (grouped markets) |
| `get_event` | Details for a specific event |
| `get_prices` | Bulk price feed for multiple markets |
| `auto_research_market` | Generate structured research prompt (autoresearch pattern) |
| `batch_research` | Research multiple markets in one loop |
| `calculate_trade` | Position sizing, R:R, Kelly criterion |
| `check_positions` | Live P&L for open positions |
| `compare_markets` | Side-by-side odds comparison |
| `edge_scanner` | Heuristic mispricing detector |

### Resources

| Resource | Description |
|----------|-------------|
| `polydesk://schemas/notion-databases` | Notion database schemas for Watchlist, Research, and Trade Journal |

### Prompts

| Prompt | Description |
|--------|-------------|
| `setup-trading-desk` | Bootstrap the full Notion workspace |
| `daily-research-loop` | Run a complete research cycle on trending markets |
| `trade-review` | Sync positions and generate P&L summary |

## How the Auto Research Loop Works

Inspired by Karpathy's autoresearch ratchet mechanism:

1. **Scan** — `scan_trending_markets` or `edge_scanner` identifies opportunities
2. **Research** — `auto_research_market` generates a structured research prompt
3. **Analyze** — The AI agent analyzes the market: base rates, evidence, fair value
4. **Record** — Findings are written to Notion via the official Notion MCP server
5. **Iterate** — Re-run with `iteration: 2, 3, ...` to refine analysis as new data arrives
6. **Ratchet** — Only upgrade conviction when evidence is stronger than previous iteration

This mirrors autoresearch's core insight: **let the AI run iterative experiments, keep what improves, discard what doesn't.**

## Setup

### 1. Install

```bash
npm install
npm run build
```

### 2. Configure Claude Desktop

Add both MCP servers to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "polydesk": {
      "command": "node",
      "args": ["/path/to/polydesk-mcp/dist/index.js"]
    },
    "notion": {
      "command": "npx",
      "args": ["-y", "@notionhq/notion-mcp-server"],
      "env": {
        "OPENAPI_MCP_HEADERS": "{\"Authorization\": \"Bearer ntn_YOUR_TOKEN\", \"Notion-Version\": \"2022-06-28\"}"
      }
    }
  }
}
```

### 3. Bootstrap Your Workspace

In Claude Desktop, run the `setup-trading-desk` prompt to create the Notion databases.

### 4. Start Researching

```
"Scan trending markets and research the top 5"
"Find markets about bitcoin and analyze the best opportunity"
"Run the daily research loop"
"Check my open positions and update the trade journal"
```

## No API Keys Required

PolyDesk uses the **public Polymarket Gamma API** — no authentication needed for market data. Notion access is handled entirely by the official Notion MCP server.

## Development

```bash
npm run dev    # Run with tsx (hot reload)
npm run check  # Type-check
npm run build  # Compile to dist/
```

## License

MIT

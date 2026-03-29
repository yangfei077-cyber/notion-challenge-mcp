# PolyDesk — Polymarket AI Research & Trading Control Plane

## What I Built

PolyDesk is an MCP server that brings **prediction market intelligence** into your AI workflow. It connects to Polymarket's real-time data and works alongside the **official Notion MCP server** to create a complete research and trading control plane — all inside Notion.

The core innovation is an **auto-research loop** inspired by [Karpathy's autoresearch](https://github.com/karpathy/autoresearch): the AI agent iteratively researches prediction markets, evaluates odds against fair value, and writes structured reports to Notion. Like autoresearch's ratchet mechanism, each iteration only updates conviction when new evidence warrants it.

## Demo

<!-- VIDEO DEMO LINK HERE -->

## How Notion MCP Is Used

PolyDesk is designed as a **companion to the official Notion MCP server**, not a replacement. The two servers work together:

- **PolyDesk MCP** → Polymarket data feeds, research intelligence, trade calculations, edge detection
- **Notion MCP** → Creates and manages the trading dashboard: Watchlist, Research Reports, Trade Journal databases

The AI agent orchestrates both servers. For example, during a research loop:
1. PolyDesk's `auto_research_market` generates a structured research prompt with live market data
2. The AI agent analyzes the market and forms a thesis
3. The Notion MCP writes the findings as a Research Report page with structured properties
4. The Notion MCP updates the Watchlist entry with the new signal and fair value

PolyDesk provides **Notion database schemas as an MCP resource** (`polydesk://schemas/notion-databases`) so the AI agent knows exactly how to structure data in Notion. It also provides **3 MCP prompts** that orchestrate multi-step workflows across both servers.

This architecture demonstrates the power of **MCP server composition** — specialized servers working together through the AI agent as orchestrator.

## Tools & Capabilities

### 12 Tools
- Market discovery: `scan_trending_markets`, `search_markets`, `get_market`, `get_events`, `get_event`
- Price feeds: `get_prices`
- Research: `auto_research_market`, `batch_research`
- Trading: `calculate_trade`, `check_positions`
- Analysis: `compare_markets`, `edge_scanner`

### 1 Resource
- `polydesk://schemas/notion-databases` — Notion database schemas for the trading desk

### 3 Prompts
- `setup-trading-desk` — Bootstrap the full Notion workspace
- `daily-research-loop` — Automated research cycle
- `trade-review` — Position sync and P&L review

## Tech Stack

- TypeScript + MCP SDK
- Polymarket Gamma API (public, no auth required)
- Official Notion MCP server (for all Notion operations)
- Deployed on Vercel (Streamable HTTP transport)

## Repo

<!-- GITHUB REPO LINK HERE -->

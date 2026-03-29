# PolyDesk Demo Script

## Recommended Recording Setup
- Terminal: Claude Desktop or Claude Code with both MCP servers configured
- Notion: Open in browser side by side
- Screen resolution: 1920x1080
- Recording tool: QuickTime / OBS / Loom
- Target length: 2-3 minutes

## Demo Flow

### Scene 1: Intro (10s)
Show the README or terminal. Say/type:
> "PolyDesk turns Polymarket into an AI-powered trading desk inside Notion."

### Scene 2: Scan Trending Markets (20s)
```
Scan the top 10 trending Polymarket markets
```
→ Shows live market data flowing in from Polymarket API

### Scene 3: Edge Scanner (20s)
```
Run the edge scanner to find potentially mispriced markets
```
→ Shows heuristic flags (overround, extreme odds, vol/liq anomalies)

### Scene 4: Setup Notion Workspace (30s)
```
Set up my PolyDesk trading desk in Notion
```
→ Uses the `setup-trading-desk` prompt
→ Switch to Notion to show the created databases (Watchlist, Research, Journal)

### Scene 5: Auto Research (40s) — THE KEY DEMO
```
Auto research the most interesting market from the scan
```
→ Shows the structured research prompt generated
→ AI analyzes: base rates, evidence, fair value, edge
→ AI writes the research report to Notion via Notion MCP
→ Switch to Notion to show the structured research page

### Scene 6: Trade Calculation (20s)
```
Calculate a trade: Yes side, $100, take profit 0.8, stop loss 0.3
```
→ Shows R:R ratio, Kelly criterion, max gain/loss

### Scene 7: Wrap Up (10s)
Show the Notion workspace with populated databases.
> "12 tools, 3 prompts, 1 resource — all working with the official Notion MCP server."

# Founder OS MCP

A Founder OS MCP server built for the DEV Notion Challenge:
[https://dev.to/challenges/notion-2026-03-04](https://dev.to/challenges/notion-2026-03-04)

This project turns Notion into an idea pipeline for founders. The intended loop is:

1. a founder records an idea
2. an agent researches competitors and substitutes
3. the agent judges risk and opportunity
4. the agent writes an execution checklist
5. everything lands in Notion as an idea pipeline plus founder memos

## Why this project fits the challenge

The challenge asks for an impressive system or process where Notion MCP is a core building block. This project is not just a CRUD wrapper:

- the MCP server exposes founder-specific tools instead of only low-level API calls
- the tools are designed for agent loops where research happens outside and the structured result is written back into Notion
- the `founder_create_idea_pipeline`, `founder_capture_idea`, and `founder_write_founder_memo` tools make the workflow concrete

## Setup

1. Create a Notion integration:
   [https://www.notion.so/profile/integrations](https://www.notion.so/profile/integrations)
2. Copy the integration token.
3. Share the target parent page with that integration.
4. Create a `.env` file:

```bash
cp .env.example .env
```

5. Add your values:

```bash
NOTION_API_KEY=ntn_your_integration_token
NOTION_PARENT_PAGE_ID=your_parent_page_id
```

## Install and run

```bash
npm install
npm run build
export $(cat .env | xargs)
npm start
```

For local development:

```bash
export $(cat .env | xargs)
npm run dev
```

## Example MCP client config

Use this server with any stdio MCP client:

```json
{
  "mcpServers": {
    "founder-os": {
      "command": "node",
      "args": [
        "/Users/yangfei/projects/mcp/dist/src/index.js"
      ],
      "env": {
        "NOTION_API_KEY": "ntn_your_integration_token",
        "NOTION_PARENT_PAGE_ID": "your_parent_page_id"
      }
    }
  }
}
```

For the deployed HTTP endpoint:

- root: `https://mcp-ten-gold.vercel.app`
- MCP endpoint: `https://mcp-ten-gold.vercel.app/mcp`

## Founder OS tools

### `founder_create_idea_pipeline`

Create a Notion database for startup ideas with stage, verdict, risk level, category, ICP, problem, and next-step fields.

### `founder_capture_idea`

Create a pipeline entry with structured sections for one-line pitch, target user, competitor signals, risk flags, evidence, and an execution checklist.

### `founder_write_founder_memo`

Create a standalone founder memo page that summarizes research, judgment, and next actions.

## Generic Notion tools

### `notion_search`

Search pages or data sources in the workspace.

### `notion_get_page`

Fetch a page with its properties.

### `notion_get_blocks`

Fetch child blocks for a page or block.

### `notion_create_page`

Create a page under a parent page and optionally seed it with markdown-ish content.

### `notion_append_markdown`

Append markdown-ish content to an existing page.

### `notion_create_task_database`

Create a reusable task database under a parent page.

### `notion_add_task`

Add a task into a Notion database.

### `notion_create_daily_brief`

Create a structured daily brief page with priorities, blockers, and notes.

## Demo flow

1. Run `founder_create_idea_pipeline` under a shared project page.
2. Ask your agent to research an idea and summarize competitor signals, risks, and evidence.
3. Run `founder_capture_idea` to create the pipeline entry.
4. Run `founder_write_founder_memo` to create a longer memo page for the same idea.
5. Use `notion_search` and `notion_get_page` to let the agent continue navigating the workspace.

## Submission draft

You can adapt this angle for the DEV post:

> I built a Founder OS on top of Notion MCP. A founder records an idea, an agent researches competitors and substitutes, judges the biggest risks, proposes an execution checklist, and writes everything back into a Notion idea pipeline plus founder memo pages. Notion becomes the operating system for deciding what to build next.

## Notes

- The server uses the Notion API version `2026-03-11`.
- The markdown support is intentionally basic: headings, bullets, numbered items, quotes, dividers, and paragraphs.
- Your integration must be invited to every page or database it should access.

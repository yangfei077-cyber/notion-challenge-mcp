# Notion Challenge MCP

A local MCP server built for the DEV Notion Challenge:
[https://dev.to/challenges/notion-2026-03-04](https://dev.to/challenges/notion-2026-03-04)

It gives an MCP-capable agent a focused set of Notion tools for running a lightweight operating system inside Notion:

- search pages and data sources
- fetch pages and blocks
- create pages from simple markdown
- append markdown to existing pages
- create a task database for the challenge demo
- add structured tasks with status and priority
- generate a daily brief page

## Why this project fits the challenge

The challenge asks for an impressive system or process where Notion MCP is a core building block. This project turns Notion into an agent-friendly control surface:

- the MCP server exposes practical Notion actions instead of raw HTTP calls
- the tools are designed for repeatable workflows, not one-off scripts
- the `create_task_database`, `add_task`, and `create_daily_brief` flows make it easy to demo a real team workflow

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
    "notion-challenge": {
      "command": "node",
      "args": [
        "/Users/yangfei/projects/mcp/dist/index.js"
      ],
      "env": {
        "NOTION_API_KEY": "ntn_your_integration_token",
        "NOTION_PARENT_PAGE_ID": "your_parent_page_id"
      }
    }
  }
}
```

## Tool list

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

Create a challenge-ready task database with status, owner, priority, and due date fields.

### `notion_add_task`

Add a task into a Notion database.

### `notion_create_daily_brief`

Create a structured daily brief page with priorities, blockers, and notes.

## Demo flow

1. Run `notion_create_task_database` under a shared project page.
2. Run `notion_add_task` a few times to seed work items.
3. Run `notion_create_daily_brief` each morning.
4. Use `notion_append_markdown` to add meeting notes or status updates.
5. Use `notion_search` and `notion_get_page` to let the agent navigate the workspace.

## Submission draft

You can adapt this angle for the DEV post:

> I built a local Notion MCP server that turns Notion into an agent-ready operating system for daily execution. Instead of only exposing raw CRUD, the server adds workflow-native tools for creating task systems, adding structured work items, and generating daily brief pages that agents can update on demand.

## Notes

- The server uses the Notion API version `2026-03-11`.
- The markdown support is intentionally basic: headings, bullets, numbered items, quotes, dividers, and paragraphs.
- Your integration must be invited to every page or database it should access.

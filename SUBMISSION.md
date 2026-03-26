# DEV Notion Challenge Submission Draft

## Title

I built a Notion MCP server that turns Notion into an agent-friendly team OS

## Pitch

For the Notion challenge, I wanted something more practical than a thin wrapper around the API. I built a local MCP server that gives agents a curated set of high-value Notion tools:

- search the workspace
- inspect pages and block trees
- create structured pages from markdown
- bootstrap a task database
- add tasks with status and priority
- generate a daily brief page for execution

The result is a lightweight "team operating system" where Notion becomes both the source of truth and the action surface for an AI agent.

## What makes it interesting

- It is usable right away with any MCP-capable client.
- It focuses on workflows instead of low-level transport details.
- It demonstrates a clear agent loop: read state from Notion, decide, then write structured updates back into Notion.

## How it works

- The MCP server runs over stdio.
- It authenticates with a standard Notion integration token.
- It uses the latest Notion API version available during the challenge build: `2026-03-11`.
- It exposes reusable tools for search, page creation, block append, task-system setup, task creation, and daily brief generation.

## Demo idea

1. Point the server at a shared project page.
2. Ask the agent to create a task database.
3. Ask it to add tasks from a rough meeting summary.
4. Ask it to generate the day's brief with priorities and blockers.
5. Ask it to append end-of-day notes back into the workspace.

## Repo note

Project root: `/Users/yangfei/projects/mcp`

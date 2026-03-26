# DEV Notion Challenge Submission Draft

## Title

I built a Founder OS on top of Notion MCP that decides what startup ideas are worth building

## Pitch

For the Notion challenge, I wanted to build something more opinionated than a generic wrapper. I turned Notion into a Founder OS:

- a founder records an idea
- an agent researches competitors and substitutes
- the agent judges risk and upside
- the agent generates an execution checklist
- the result lands in a Notion idea pipeline and a founder memo page

The result is a workflow where Notion becomes the system of record for deciding what to build, what to validate, and what to ignore.

## What makes it interesting

- It is usable right away with any MCP-capable client.
- It focuses on startup decision-making instead of low-level API plumbing.
- It demonstrates a clear agent loop: research outside, judge, then write structured output back into Notion.

## How it works

- The MCP server runs over stdio and Streamable HTTP.
- It authenticates with a standard Notion integration token.
- It uses the latest Notion API version available during the challenge build: `2026-03-11`.
- It exposes startup-specific tools like `founder_create_idea_pipeline`, `founder_capture_idea`, and `founder_write_founder_memo`.

## Demo idea

1. Point the server at a shared project page.
2. Ask the agent to create the Founder OS idea pipeline.
3. Give the agent a startup idea and have it research competitor signals.
4. Ask it to judge the main risks and generate an execution checklist.
5. Have it write the result into the pipeline and a founder memo page.

## Repo note

Project root: `/Users/yangfei/projects/mcp`

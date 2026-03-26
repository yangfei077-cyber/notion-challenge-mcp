import { inspect } from "node:util";
import { APIErrorCode, Client as NotionClient, ClientErrorCode, isNotionClientError } from "@notionhq/client";
import type { BlockObjectRequest, CreateDatabaseParameters, CreatePageParameters } from "@notionhq/client";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const NOTION_VERSION = "2026-03-11";
const DEFAULT_PARENT_PAGE_ID = process.env.NOTION_PARENT_PAGE_ID?.trim();

function getNotionClient(): NotionClient {
  const auth = process.env.NOTION_API_KEY?.trim();
  if (!auth) {
    throw new Error("Missing NOTION_API_KEY. Add it to your environment before starting the server.");
  }

  return new NotionClient({
    auth,
    notionVersion: NOTION_VERSION,
  });
}

function summarize(value: unknown): string {
  return inspect(value, {
    depth: 6,
    breakLength: 100,
    colors: false,
    maxArrayLength: 20,
  });
}

function asTextResult(title: string, body: unknown) {
  const text = typeof body === "string" ? body : summarize(body);
  return {
    content: [
      {
        type: "text" as const,
        text: `${title}\n\n${text}`,
      },
    ],
  };
}

function normalizeId(raw: string): string {
  return raw.trim().replace(/-/g, "");
}

function withFallbackParent(pageId?: string): string {
  const selected = pageId?.trim() || DEFAULT_PARENT_PAGE_ID;
  if (!selected) {
    throw new Error("A parent page ID is required. Pass parentPageId or set NOTION_PARENT_PAGE_ID.");
  }
  return normalizeId(selected);
}

function plainTextFromRichText(parts: Array<{ plain_text?: string }> | undefined): string {
  return (parts ?? []).map((part) => part.plain_text ?? "").join("");
}

function splitParagraphs(markdown: string): string[] {
  return markdown
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function richText(content: string) {
  return [{ type: "text" as const, text: { content } }];
}

function lineToBlock(line: string): BlockObjectRequest | null {
  const trimmed = line.trim();

  if (!trimmed) {
    return null;
  }

  if (trimmed.startsWith("### ")) {
    return {
      object: "block",
      type: "heading_3",
      heading_3: {
        rich_text: richText(trimmed.slice(4)),
      },
    };
  }

  if (trimmed.startsWith("## ")) {
    return {
      object: "block",
      type: "heading_2",
      heading_2: {
        rich_text: richText(trimmed.slice(3)),
      },
    };
  }

  if (trimmed.startsWith("# ")) {
    return {
      object: "block",
      type: "heading_1",
      heading_1: {
        rich_text: richText(trimmed.slice(2)),
      },
    };
  }

  if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
    return {
      object: "block",
      type: "bulleted_list_item",
      bulleted_list_item: {
        rich_text: richText(trimmed.slice(2)),
      },
    };
  }

  if (/^\d+\.\s/.test(trimmed)) {
    return {
      object: "block",
      type: "numbered_list_item",
      numbered_list_item: {
        rich_text: richText(trimmed.replace(/^\d+\.\s/, "")),
      },
    };
  }

  if (trimmed.startsWith("> ")) {
    return {
      object: "block",
      type: "quote",
      quote: {
        rich_text: richText(trimmed.slice(2)),
      },
    };
  }

  if (trimmed === "---") {
    return {
      object: "block",
      type: "divider",
      divider: {},
    };
  }

  return {
    object: "block",
    type: "paragraph",
    paragraph: {
      rich_text: richText(trimmed),
    },
  };
}

function markdownToBlocks(markdown: string): BlockObjectRequest[] {
  return splitParagraphs(markdown)
    .flatMap((paragraph) => paragraph.split("\n"))
    .map((line) => lineToBlock(line))
    .filter((block): block is BlockObjectRequest => block !== null);
}

function titleProperty(value: string) {
  return {
    title: richText(value),
  } satisfies NonNullable<CreatePageParameters["properties"]>[string];
}

function richTextProperty(value: string) {
  return {
    rich_text: richText(value),
  } satisfies NonNullable<CreatePageParameters["properties"]>[string];
}

function selectProperty(value: string) {
  return {
    select: { name: value },
  } satisfies NonNullable<CreatePageParameters["properties"]>[string];
}

function statusProperty(value: string) {
  return {
    status: { name: value },
  } satisfies NonNullable<CreatePageParameters["properties"]>[string];
}

function textSection(title: string, body: string | undefined, fallback: string): string[] {
  return [title, body?.trim() || fallback];
}

function bulletSection(title: string, items: string[], fallback: string): string[] {
  return [title, ...(items.length > 0 ? items.map((item) => `- ${item}`) : [`- ${fallback}`])];
}

function numberedSection(title: string, items: string[], fallback: string): string[] {
  return [title, ...(items.length > 0 ? items.map((item, index) => `${index + 1}. ${item}`) : [`1. ${fallback}`])];
}

function buildFounderMemoMarkdown(input: {
  ideaTitle: string;
  oneLinePitch?: string;
  problem?: string;
  targetUser?: string;
  differentiators: string[];
  competitors: string[];
  risks: string[];
  evidence: string[];
  executionChecklist: string[];
  verdictSummary?: string;
  nextStep?: string;
}) {
  return [
    `# Founder Memo: ${input.ideaTitle}`,
    ...textSection("## One-line pitch", input.oneLinePitch, "No one-line pitch captured yet."),
    ...textSection("## Problem", input.problem, "No problem statement captured yet."),
    ...textSection("## Target user", input.targetUser, "No target user captured yet."),
    ...bulletSection("## Differentiators", input.differentiators, "No differentiators yet."),
    ...bulletSection("## Competitor signals", input.competitors, "No competitors recorded yet."),
    ...bulletSection("## Risk flags", input.risks, "No risks recorded yet."),
    ...bulletSection("## Evidence", input.evidence, "No evidence recorded yet."),
    ...numberedSection("## Execution checklist", input.executionChecklist, "Define the first execution step."),
    ...textSection("## Verdict", input.verdictSummary, "No verdict summary yet."),
    ...textSection("## Next step", input.nextStep, "No next step yet."),
  ].join("\n");
}

function notionErrorMessage(error: unknown): string {
  if (!isNotionClientError(error)) {
    return error instanceof Error ? error.message : String(error);
  }

  if (error.code === ClientErrorCode.RequestTimeout) {
    return "Notion request timed out.";
  }

  if (error.code === APIErrorCode.ObjectNotFound) {
    return "The requested Notion object was not found or was not shared with this integration.";
  }

  if (error.code === APIErrorCode.Unauthorized) {
    return "The Notion API key is invalid or no longer authorized.";
  }

  if (error.code === APIErrorCode.RateLimited) {
    return "The Notion API rate limit was reached. Please retry shortly.";
  }

  return `${error.code}: ${error.message}`;
}

async function runTool<T>(label: string, action: () => Promise<T>) {
  try {
    return await action();
  } catch (error) {
    return {
      content: [
        {
          type: "text" as const,
          text: `${label} failed\n\n${notionErrorMessage(error)}`,
        },
      ],
      isError: true,
    };
  }
}

export function createServer() {
  const server = new McpServer(
    {
      name: "notion-challenge-mcp",
      version: "0.2.0",
    },
    {
      capabilities: {
        logging: {},
      },
    },
  );

  server.registerTool(
    "notion_search",
    {
      title: "Search Notion",
      description: "Search pages and data sources in the connected Notion workspace.",
      inputSchema: {
        query: z.string().min(1).describe("Search text to send to Notion."),
        filter: z.enum(["page", "data_source"]).optional().describe("Limit results by object type."),
        pageSize: z.number().int().min(1).max(100).default(10).describe("Max results to return."),
      },
    },
    async ({ query, filter, pageSize }) =>
      runTool("notion_search", async () => {
        const notion = getNotionClient();
        const response = await notion.search({
          query,
          page_size: pageSize,
          ...(filter ? { filter: { property: "object", value: filter } } : {}),
        });

        const results = response.results.map((entry) => {
          if (entry.object === "page") {
            return {
              id: entry.id,
              object: entry.object,
              url: "url" in entry ? entry.url : undefined,
              title:
                plainTextFromRichText(
                  "properties" in entry && entry.properties && "title" in entry.properties
                    ? entry.properties.title.type === "title"
                      ? entry.properties.title.title
                      : undefined
                    : undefined,
                ) ||
                plainTextFromRichText(
                  "properties" in entry && entry.properties && "Name" in entry.properties
                    ? entry.properties.Name.type === "title"
                      ? entry.properties.Name.title
                      : undefined
                    : undefined,
                ) ||
                "Untitled page",
            };
          }

          return {
            id: entry.id,
            object: entry.object,
            url: "url" in entry ? entry.url : undefined,
            title: "title" in entry ? plainTextFromRichText(entry.title) || "Untitled data source" : "Untitled data source",
          };
        });

        return asTextResult("Search results", results);
      }),
  );

  server.registerTool(
    "notion_get_page",
    {
      title: "Get Notion Page",
      description: "Fetch a page and summarize its key properties.",
      inputSchema: {
        pageId: z.string().min(1).describe("The Notion page ID."),
      },
    },
    async ({ pageId }) =>
      runTool("notion_get_page", async () => {
        const notion = getNotionClient();
        const response = await notion.pages.retrieve({
          page_id: normalizeId(pageId),
        });
        return asTextResult("Page", response);
      }),
  );

  server.registerTool(
    "notion_get_blocks",
    {
      title: "Get Page Blocks",
      description: "Fetch child blocks for a page or block.",
      inputSchema: {
        blockId: z.string().min(1).describe("The Notion block or page ID."),
        pageSize: z.number().int().min(1).max(100).default(100).describe("Max child blocks to return."),
      },
    },
    async ({ blockId, pageSize }) =>
      runTool("notion_get_blocks", async () => {
        const notion = getNotionClient();
        const response = await notion.blocks.children.list({
          block_id: normalizeId(blockId),
          page_size: pageSize,
        });
        return asTextResult("Blocks", response.results);
      }),
  );

  server.registerTool(
    "notion_create_page",
    {
      title: "Create Notion Page",
      description: "Create a page under a parent page and optionally seed it with simple markdown content.",
      inputSchema: {
        title: z.string().min(1).describe("Page title."),
        parentPageId: z.string().optional().describe("Optional parent page ID. Falls back to NOTION_PARENT_PAGE_ID."),
        markdown: z.string().optional().describe("Optional markdown-ish text converted into basic Notion blocks."),
      },
    },
    async ({ title, parentPageId, markdown }) =>
      runTool("notion_create_page", async () => {
        const notion = getNotionClient();
        const children = markdown ? markdownToBlocks(markdown).slice(0, 100) : undefined;
        const response = await notion.pages.create({
          parent: {
            page_id: withFallbackParent(parentPageId),
          },
          properties: {
            title: titleProperty(title),
          },
          ...(children && children.length > 0 ? { children } : {}),
        });
        return asTextResult("Created page", response);
      }),
  );

  server.registerTool(
    "notion_append_markdown",
    {
      title: "Append Markdown",
      description: "Append markdown-ish content to an existing page as Notion blocks.",
      inputSchema: {
        pageId: z.string().min(1).describe("Target page ID."),
        markdown: z.string().min(1).describe("Markdown-ish content to append."),
      },
    },
    async ({ pageId, markdown }) =>
      runTool("notion_append_markdown", async () => {
        const notion = getNotionClient();
        const children = markdownToBlocks(markdown).slice(0, 100);
        if (children.length === 0) {
          throw new Error("No blocks were generated from the markdown input.");
        }
        const response = await notion.blocks.children.append({
          block_id: normalizeId(pageId),
          children,
        });
        return asTextResult("Appended blocks", response.results);
      }),
  );

  server.registerTool(
    "notion_create_task_database",
    {
      title: "Create Task Database",
      description: "Create a reusable task database under a parent page for the challenge demo.",
      inputSchema: {
        parentPageId: z.string().optional().describe("Optional parent page ID. Falls back to NOTION_PARENT_PAGE_ID."),
        title: z.string().default("Challenge Tasks").describe("Database title."),
      },
    },
    async ({ parentPageId, title }) =>
      runTool("notion_create_task_database", async () => {
        const notion = getNotionClient();
        const request: CreateDatabaseParameters = {
          parent: {
            page_id: withFallbackParent(parentPageId),
            type: "page_id",
          },
          title: [{ type: "text", text: { content: title } }],
          initial_data_source: {
            properties: {
              Name: { title: {} },
              Status: {
                status: {
                  options: [
                    { name: "Inbox", color: "gray" },
                    { name: "Next", color: "blue" },
                    { name: "Doing", color: "yellow" },
                    { name: "Done", color: "green" },
                  ],
                },
              },
              Owner: {
                rich_text: {},
              },
              Priority: {
                select: {
                  options: [
                    { name: "High", color: "red" },
                    { name: "Medium", color: "yellow" },
                    { name: "Low", color: "gray" },
                  ],
                },
              },
              "Due Date": {
                date: {},
              },
            },
          },
        };
        const response = await notion.databases.create(request);
        return asTextResult("Created task database", response);
      }),
  );

  server.registerTool(
    "founder_create_idea_pipeline",
    {
      title: "Create Founder Idea Pipeline",
      description: "Create a Founder OS idea pipeline database with startup-specific properties.",
      inputSchema: {
        parentPageId: z.string().optional().describe("Optional parent page ID. Falls back to NOTION_PARENT_PAGE_ID."),
        title: z.string().default("Founder OS Idea Pipeline").describe("Database title."),
      },
    },
    async ({ parentPageId, title }) =>
      runTool("founder_create_idea_pipeline", async () => {
        const notion = getNotionClient();
        const request: CreateDatabaseParameters = {
          parent: {
            page_id: withFallbackParent(parentPageId),
            type: "page_id",
          },
          title: richText(title),
          initial_data_source: {
            properties: {
              Name: { title: {} },
              Stage: {
                status: {
                  options: [
                    { name: "Inbox", color: "gray" },
                    { name: "Researching", color: "blue" },
                    { name: "Validating", color: "yellow" },
                    { name: "Building", color: "orange" },
                    { name: "Launched", color: "green" },
                    { name: "Archived", color: "brown" },
                  ],
                },
              },
              Verdict: {
                select: {
                  options: [
                    { name: "Promising", color: "green" },
                    { name: "Needs data", color: "yellow" },
                    { name: "Risky", color: "orange" },
                    { name: "Avoid", color: "red" },
                  ],
                },
              },
              "Risk Level": {
                select: {
                  options: [
                    { name: "Low", color: "green" },
                    { name: "Medium", color: "yellow" },
                    { name: "High", color: "red" },
                  ],
                },
              },
              Category: {
                select: {
                  options: [
                    { name: "AI SaaS", color: "blue" },
                    { name: "Consumer", color: "pink" },
                    { name: "Marketplace", color: "purple" },
                    { name: "Developer Tools", color: "gray" },
                    { name: "Enterprise", color: "brown" },
                  ],
                },
              },
              ICP: { rich_text: {} },
              Problem: { rich_text: {} },
              "Next Step": { rich_text: {} },
            },
          },
        };

        const response = await notion.databases.create(request);
        return asTextResult("Created founder idea pipeline", response);
      }),
  );

  server.registerTool(
    "founder_capture_idea",
    {
      title: "Capture Founder Idea",
      description: "Create an idea entry inside the Founder OS pipeline with research summary, risks, and checklist.",
      inputSchema: {
        databaseId: z.string().min(1).describe("The Founder OS idea pipeline database ID."),
        ideaTitle: z.string().min(1).describe("Short working title for the startup idea."),
        oneLinePitch: z.string().optional().describe("One-sentence summary of the idea."),
        problem: z.string().optional().describe("Problem the startup is trying to solve."),
        targetUser: z.string().optional().describe("Ideal customer profile or target audience."),
        category: z.string().default("AI SaaS").describe("Idea category."),
        stage: z.string().default("Inbox").describe("Current pipeline stage."),
        verdict: z.string().default("Needs data").describe("Current judgment on the idea."),
        riskLevel: z.string().default("Medium").describe("Overall risk level."),
        nextStep: z.string().optional().describe("Highest-leverage next action."),
        competitors: z.array(z.string()).default([]).describe("Known competitors or substitutes."),
        differentiators: z.array(z.string()).default([]).describe("What feels different or defensible."),
        risks: z.array(z.string()).default([]).describe("Top risks discovered so far."),
        evidence: z.array(z.string()).default([]).describe("Proof points, demand signals, or observations."),
        executionChecklist: z.array(z.string()).default([]).describe("Action plan for validation or execution."),
      },
    },
    async ({
      databaseId,
      ideaTitle,
      oneLinePitch,
      problem,
      targetUser,
      category,
      stage,
      verdict,
      riskLevel,
      nextStep,
      competitors,
      differentiators,
      risks,
      evidence,
      executionChecklist,
    }) =>
      runTool("founder_capture_idea", async () => {
        const notion = getNotionClient();
        const response = await notion.pages.create({
          parent: {
            database_id: normalizeId(databaseId),
          },
          properties: {
            Name: titleProperty(ideaTitle),
            Stage: statusProperty(stage),
            Verdict: selectProperty(verdict),
            "Risk Level": selectProperty(riskLevel),
            Category: selectProperty(category),
            ...(targetUser ? { ICP: richTextProperty(targetUser) } : {}),
            ...(problem ? { Problem: richTextProperty(problem) } : {}),
            ...(nextStep ? { "Next Step": richTextProperty(nextStep) } : {}),
          },
          children: markdownToBlocks(
            buildFounderMemoMarkdown({
              ideaTitle,
              oneLinePitch,
              problem,
              targetUser,
              differentiators,
              competitors,
              risks,
              evidence,
              executionChecklist,
              verdictSummary: verdict,
              nextStep,
            }),
          ).slice(0, 100),
        });

        return asTextResult("Captured founder idea", response);
      }),
  );

  server.registerTool(
    "founder_write_founder_memo",
    {
      title: "Write Founder Memo",
      description: "Create a standalone founder memo page with competitor research, risks, and an execution checklist.",
      inputSchema: {
        parentPageId: z.string().optional().describe("Optional parent page ID. Falls back to NOTION_PARENT_PAGE_ID."),
        ideaTitle: z.string().min(1).describe("Idea title."),
        oneLinePitch: z.string().optional().describe("One-line summary."),
        problem: z.string().optional().describe("Problem statement."),
        targetUser: z.string().optional().describe("Target user or ICP."),
        verdictSummary: z.string().optional().describe("High-level recommendation."),
        nextStep: z.string().optional().describe("Immediate next action."),
        competitors: z.array(z.string()).default([]).describe("Competitor research notes."),
        differentiators: z.array(z.string()).default([]).describe("Differentiators or moat hypotheses."),
        risks: z.array(z.string()).default([]).describe("Risks or reasons not to build."),
        evidence: z.array(z.string()).default([]).describe("Signals that support or weaken the idea."),
        executionChecklist: z.array(z.string()).default([]).describe("Execution plan the founder should follow next."),
      },
    },
    async ({
      parentPageId,
      ideaTitle,
      oneLinePitch,
      problem,
      targetUser,
      verdictSummary,
      nextStep,
      competitors,
      differentiators,
      risks,
      evidence,
      executionChecklist,
    }) =>
      runTool("founder_write_founder_memo", async () => {
        const notion = getNotionClient();
        const markdown = buildFounderMemoMarkdown({
          ideaTitle,
          oneLinePitch,
          problem,
          targetUser,
          differentiators,
          competitors,
          risks,
          evidence,
          executionChecklist,
          verdictSummary,
          nextStep,
        });

        const response = await notion.pages.create({
          parent: {
            page_id: withFallbackParent(parentPageId),
          },
          properties: {
            title: titleProperty(`${ideaTitle} Founder Memo`),
          },
          children: markdownToBlocks(markdown).slice(0, 100),
        });

        return asTextResult("Created founder memo", response);
      }),
  );

  server.registerTool(
    "notion_add_task",
    {
      title: "Add Task",
      description: "Create a task page inside a database with status and priority fields.",
      inputSchema: {
        databaseId: z.string().min(1).describe("Target database ID."),
        title: z.string().min(1).describe("Task title."),
        status: z.string().default("Inbox").describe("Task status."),
        priority: z.string().default("Medium").describe("Task priority."),
        owner: z.string().optional().describe("Optional owner name."),
        dueDate: z.string().optional().describe("Optional due date in ISO format."),
        notes: z.string().optional().describe("Optional markdown-ish notes for the task body."),
      },
    },
    async ({ databaseId, title, status, priority, owner, dueDate, notes }) =>
      runTool("notion_add_task", async () => {
        const notion = getNotionClient();
        const response = await notion.pages.create({
          parent: {
            database_id: normalizeId(databaseId),
          },
          properties: {
            Name: titleProperty(title),
            Status: statusProperty(status),
            Priority: selectProperty(priority),
            ...(owner ? { Owner: richTextProperty(owner) } : {}),
            ...(dueDate ? { "Due Date": { date: { start: dueDate } } } : {}),
          },
          ...(notes ? { children: markdownToBlocks(notes).slice(0, 100) } : {}),
        });
        return asTextResult("Created task", response);
      }),
  );

  server.registerTool(
    "notion_create_daily_brief",
    {
      title: "Create Daily Brief",
      description: "Create a structured daily brief page under a parent page, suitable for the challenge demo.",
      inputSchema: {
        date: z.string().describe("The date label for the brief, such as 2026-03-26."),
        parentPageId: z.string().optional().describe("Optional parent page ID. Falls back to NOTION_PARENT_PAGE_ID."),
        priorities: z.array(z.string()).default([]).describe("Top priorities for the day."),
        blockers: z.array(z.string()).default([]).describe("Known blockers."),
        notes: z.array(z.string()).default([]).describe("Short updates or notes."),
      },
    },
    async ({ date, parentPageId, priorities, blockers, notes }) =>
      runTool("notion_create_daily_brief", async () => {
        const notion = getNotionClient();
        const sections = [
          `# Daily Brief: ${date}`,
          "## Priorities",
          ...(priorities.length > 0 ? priorities.map((item) => `- ${item}`) : ["- No priorities yet"]),
          "## Blockers",
          ...(blockers.length > 0 ? blockers.map((item) => `- ${item}`) : ["- No blockers"]),
          "## Notes",
          ...(notes.length > 0 ? notes.map((item) => `- ${item}`) : ["- No notes yet"]),
        ].join("\n");

        const response = await notion.pages.create({
          parent: {
            page_id: withFallbackParent(parentPageId),
          },
          properties: {
            title: titleProperty(`Daily Brief ${date}`),
          },
          children: markdownToBlocks(sections).slice(0, 100),
        });
        return asTextResult("Created daily brief", response);
      }),
  );

  return server;
}

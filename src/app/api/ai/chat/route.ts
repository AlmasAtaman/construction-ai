import { NextResponse } from "next/server";
import { z } from "zod";
import type { Anthropic as AnthropicNS } from "@anthropic-ai/sdk";
import { db } from "@/lib/db";
import { getAnthropic, MissingApiKeyError } from "@/lib/anthropic";
import { gateAiCall, trackApiUsage } from "@/lib/rate-limit";
import { CHAT_TOOLS, type ToolChanges, type ToolFilter } from "@/lib/ai/tools";
import { buildChatSystemPrompt } from "@/lib/ai/chat-prompt";
import {
  DEFAULT_MODEL,
  MAX_CHAT_MESSAGES_PER_PROJECT_PER_DAY,
} from "@/lib/constants";
import { isTestMode } from "@/lib/ai/test-mode";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

const bodySchema = z.object({
  projectId: z.string().min(1),
  message: z.string().min(1),
  confirmBulkToken: z.string().optional(),
});

const BULK_THRESHOLD = 10;

interface ToolExecution {
  name: string;
  input: Record<string, unknown>;
  result: unknown;
  affectedCount?: number;
  description: string;
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Could not read your message." },
      { status: 400 },
    );
  }

  const project = await db.project.findUnique({
    where: { id: parsed.data.projectId },
  });
  if (!project) {
    return NextResponse.json(
      { error: "Project not found." },
      { status: 404 },
    );
  }

  // Gate (rate limit + budget).
  const gate = await gateAiCall({
    perCallerKey: `chat:${project.id}`,
    perCallerMax: MAX_CHAT_MESSAGES_PER_PROJECT_PER_DAY,
    perCallerWindowSeconds: 24 * 60 * 60,
  });
  if (!gate.allowed) {
    return NextResponse.json({ error: gate.reason }, { status: gate.status });
  }

  // Persist the user's message.
  await db.chatMessage.create({
    data: {
      projectId: project.id,
      role: "user",
      content: parsed.data.message,
    },
  });

  // Load active painter rules.
  const rules = await db.painterRule.findMany({
    where: { active: true },
    orderBy: { createdAt: "asc" },
  });

  // Build live project context so the AI can ground filters in real data.
  const projectSurfaces = await db.surface.findMany({
    where: { projectId: project.id },
    select: {
      type: true,
      roomLabel: true,
      paintType: true,
      status: true,
    },
  });
  const roomLabels = Array.from(
    new Set(
      projectSurfaces
        .map((s) => s.roomLabel?.trim())
        .filter((l): l is string => !!l),
    ),
  ).sort();
  const paintTypesInUse = Array.from(
    new Set(
      projectSurfaces
        .map((s) => s.paintType?.trim())
        .filter((l): l is string => !!l),
    ),
  ).sort();
  const surfaceCountByType: Record<string, number> = {};
  for (const s of projectSurfaces) {
    if (s.status === "excluded") continue;
    surfaceCountByType[s.type] = (surfaceCountByType[s.type] ?? 0) + 1;
  }
  const plans = await db.plan.findMany({
    where: { projectId: project.id },
    include: { pages: { select: { pageNumber: true } } },
  });
  const pageLabels = plans.flatMap((p) =>
    p.pages.map((pg) => `${p.filename} p${pg.pageNumber}`),
  );

  const systemPrompt = buildChatSystemPrompt(
    rules.map((r) => r.rule),
    {
      projectName: project.name,
      clientName: project.clientName ?? undefined,
      roomLabels,
      paintTypesInUse,
      surfaceCountByType,
      wasteFactor: project.wasteFactor,
      markup: project.markup,
      measurementMode: project.measurementMode,
      pageLabels,
    },
  );

  // Load recent history.
  const history = await db.chatMessage.findMany({
    where: { projectId: project.id },
    orderBy: { createdAt: "asc" },
    take: 30,
  });

  const messages: AnthropicNS.Messages.MessageParam[] = history
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    }));

  let inputTokens = 0;
  let outputTokens = 0;
  let assistantText = "";
  const executions: ToolExecution[] = [];
  let pendingConfirmation: {
    token: string;
    summary: string;
    toolUse: { name: string; input: Record<string, unknown> };
  } | null = null;

  try {
    if (isTestMode()) {
      // Deterministic interpretation: match patterns in the user message.
      const result = await runTestModeChat(project.id, parsed.data);
      assistantText = result.assistantText;
      executions.push(...result.executions);
      pendingConfirmation = result.pendingConfirmation;
      inputTokens = 1200;
      outputTokens = 240;
    } else {
      const anthropic = getAnthropic();

      // If this is a confirmation, replay the pending action without re-calling Claude.
      if (parsed.data.confirmBulkToken) {
        const pending = await db.chatMessage.findFirst({
          where: {
            projectId: project.id,
            role: "system",
            content: { contains: parsed.data.confirmBulkToken },
          },
          orderBy: { createdAt: "desc" },
        });
        if (pending) {
          const payload = JSON.parse(pending.content) as {
            token: string;
            toolUse: { name: string; input: Record<string, unknown> };
          };
          const ex = await executeTool(
            project.id,
            payload.toolUse.name,
            payload.toolUse.input,
          );
          executions.push(ex);
          assistantText = `Done. ${ex.description}`;
        } else {
          assistantText =
            "I couldn't find the pending action to confirm. Try the command again.";
        }
      } else {
        // Agent loop: call Claude, handle tool_use, optionally loop with results.
        let loopGuard = 0;
        const convoMessages = [...messages];

        while (loopGuard++ < 4) {
          const response = await anthropic.messages.create({
            model: DEFAULT_MODEL,
            max_tokens: 1024,
            system: [
              {
                type: "text",
                text: systemPrompt,
                cache_control: { type: "ephemeral" },
              },
            ],
            tools: CHAT_TOOLS,
            messages: convoMessages,
          });

          inputTokens += response.usage.input_tokens;
          outputTokens += response.usage.output_tokens;

          // Collect text + tool uses
          let textChunk = "";
          const toolUses: {
            id: string;
            name: string;
            input: Record<string, unknown>;
          }[] = [];
          for (const block of response.content) {
            if (block.type === "text") textChunk += block.text;
            if (block.type === "tool_use") {
              toolUses.push({
                id: block.id,
                name: block.name,
                input: block.input as Record<string, unknown>,
              });
            }
          }
          assistantText += textChunk;

          if (toolUses.length === 0) break;

          // Execute tools and push results back.
          const toolResults: AnthropicNS.Messages.ToolResultBlockParam[] = [];
          let stoppedForConfirmation = false;

          for (const tu of toolUses) {
            const affectedCount = await previewToolAffected(
              project.id,
              tu.name,
              tu.input,
            );
            if (affectedCount > BULK_THRESHOLD) {
              const token = randomToken();
              const summary = summarizeTool(
                tu.name,
                tu.input,
                affectedCount,
              );
              await db.chatMessage.create({
                data: {
                  projectId: project.id,
                  role: "system",
                  content: JSON.stringify({
                    token,
                    toolUse: tu,
                  }),
                },
              });
              pendingConfirmation = { token, summary, toolUse: tu };
              assistantText +=
                (assistantText ? "\n\n" : "") +
                `I'm ready to ${summary} — please confirm.`;
              stoppedForConfirmation = true;
              break;
            }

            const ex = await executeTool(project.id, tu.name, tu.input);
            executions.push(ex);
            toolResults.push({
              type: "tool_result",
              tool_use_id: tu.id,
              content: JSON.stringify(ex.result).slice(0, 4000),
            });
          }

          if (stoppedForConfirmation) break;

          convoMessages.push({
            role: "assistant",
            content: response.content as AnthropicNS.Messages.ContentBlockParam[],
          });
          convoMessages.push({
            role: "user",
            content: toolResults,
          });

          if (response.stop_reason !== "tool_use") break;
        }
      }
    }
  } catch (err) {
    if (err instanceof MissingApiKeyError) {
      return NextResponse.json({ error: err.message }, { status: 500 });
    }
    return NextResponse.json(
      {
        error:
          "The AI couldn't reply right now. Wait a moment and try again.",
      },
      { status: 502 },
    );
  }

  if (!assistantText.trim() && executions.length === 0 && !pendingConfirmation) {
    assistantText =
      "Sorry, I didn't catch that. Try rephrasing in plain English.";
  }

  await trackApiUsage("chat", DEFAULT_MODEL, inputTokens, outputTokens);

  await db.chatMessage.create({
    data: {
      projectId: project.id,
      role: "assistant",
      content: assistantText,
      toolCalls:
        executions.length > 0
          ? JSON.stringify(executions.map((e) => ({
              name: e.name,
              description: e.description,
              affectedCount: e.affectedCount,
            })))
          : null,
    },
  });

  return NextResponse.json({
    assistantText,
    executions: executions.map((e) => ({
      name: e.name,
      description: e.description,
      affectedCount: e.affectedCount,
      result: e.result,
    })),
    pendingConfirmation,
  });
}

function randomToken(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

interface SurfaceWhere {
  projectId: string;
  type?: string;
  paintType?: string;
  OR?: Array<{ roomLabel: { contains: string } }>;
}

/**
 * Build a Prisma `where` clause from a chat tool filter.
 *
 * Important: `roomLabelPattern` may be pipe-separated synonyms
 * ("bathroom|restroom|powder") — we split and OR them. SQLite LIKE is
 * case-insensitive for ASCII by default so `{ contains: ... }` matches
 * regardless of label capitalization.
 */
function buildWhere(
  projectId: string,
  filter: ToolFilter | undefined,
): SurfaceWhere {
  const where: SurfaceWhere = { projectId };
  if (filter?.surfaceType) where.type = filter.surfaceType;
  if (filter?.currentPaintType) where.paintType = filter.currentPaintType;
  if (filter?.roomLabelPattern) {
    const alternatives = filter.roomLabelPattern
      .split("|")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (alternatives.length === 1) {
      // Single term — a simple substring match is enough.
      where.OR = [{ roomLabel: { contains: alternatives[0] } }];
    } else if (alternatives.length > 1) {
      where.OR = alternatives.map((alt) => ({
        roomLabel: { contains: alt },
      }));
    }
  }
  return where;
}

async function previewToolAffected(
  projectId: string,
  name: string,
  input: Record<string, unknown>,
): Promise<number> {
  if (name === "update_surfaces" || name === "exclude_surfaces" || name === "apply_assembly") {
    const filter = input.filter as ToolFilter | undefined;
    return db.surface.count({ where: buildWhere(projectId, filter) });
  }
  return 0;
}

function summarizeTool(
  name: string,
  input: Record<string, unknown>,
  count: number,
): string {
  const plural = (n: number) => `${n} surface${n === 1 ? "" : "s"}`;
  if (name === "update_surfaces") {
    const changes = input.changes as ToolChanges | undefined;
    const filter = input.filter as ToolFilter | undefined;
    const target = filter?.roomLabelPattern
      ? `in rooms matching "${filter.roomLabelPattern}"`
      : "";
    const what = filter?.surfaceType ? `${filter.surfaceType}s` : "surfaces";
    if (changes?.paintType) {
      return `change ${count} ${what} ${target} to ${changes.paintType}`;
    }
    if (typeof changes?.coats === "number") {
      return `change coats on ${count} ${what} ${target} to ${changes.coats}`;
    }
    return `update ${plural(count)}`;
  }
  if (name === "exclude_surfaces")
    return `exclude ${plural(count)} from the bid`;
  return `update ${plural(count)}`;
}

async function executeTool(
  projectId: string,
  name: string,
  input: Record<string, unknown>,
): Promise<ToolExecution> {
  if (name === "update_surfaces") {
    const filter = input.filter as ToolFilter | undefined;
    const changes = input.changes as ToolChanges | undefined;
    const where = buildWhere(projectId, filter);
    const data: Record<string, unknown> = {};
    if (changes?.paintType) data.paintType = changes.paintType;
    if (typeof changes?.coats === "number") data.coats = changes.coats;
    if (changes?.substrate) data.substrate = changes.substrate;
    if (changes?.status) data.status = changes.status;

    const before = await db.surface.findMany({ where, select: { id: true, paintType: true, coats: true, substrate: true, status: true } });
    const result = await db.surface.updateMany({ where, data });

    const description = summarizeTool(name, input, result.count);
    await db.auditEntry.create({
      data: {
        projectId,
        action: capitalize(description) + ".",
        source: "ai",
        before: JSON.stringify(before),
        after: JSON.stringify({ filter, changes, count: result.count }),
      },
    });

    return {
      name,
      input,
      result: { updated: result.count },
      affectedCount: result.count,
      description: capitalize(description),
    };
  }

  if (name === "exclude_surfaces") {
    const filter = input.filter as ToolFilter | undefined;
    const where = buildWhere(projectId, filter);
    const before = await db.surface.findMany({ where, select: { id: true, status: true } });
    const result = await db.surface.updateMany({
      where,
      data: { status: "excluded" },
    });
    const description = `Excluded ${result.count} surface${result.count === 1 ? "" : "s"} from the bid`;
    await db.auditEntry.create({
      data: {
        projectId,
        action: description + ".",
        source: "ai",
        before: JSON.stringify(before),
        after: JSON.stringify({ filter, count: result.count }),
      },
    });
    return {
      name,
      input,
      result: { excluded: result.count },
      affectedCount: result.count,
      description,
    };
  }

  if (name === "set_waste_factor") {
    const pct = (input.percentage as number) ?? 0;
    const before = await db.project.findUnique({
      where: { id: projectId },
      select: { wasteFactor: true },
    });
    await db.project.update({
      where: { id: projectId },
      data: { wasteFactor: pct / 100 },
    });
    const description = `Set waste factor to ${pct}%`;
    await db.auditEntry.create({
      data: {
        projectId,
        action: description + ".",
        source: "ai",
        before: JSON.stringify(before),
        after: JSON.stringify({ wasteFactor: pct / 100 }),
      },
    });
    return { name, input, result: { wasteFactor: pct / 100 }, description };
  }

  if (name === "set_markup") {
    const pct = (input.percentage as number) ?? 0;
    const before = await db.project.findUnique({
      where: { id: projectId },
      select: { markup: true },
    });
    await db.project.update({
      where: { id: projectId },
      data: { markup: pct / 100 },
    });
    const description = `Set markup to ${pct}%`;
    await db.auditEntry.create({
      data: {
        projectId,
        action: description + ".",
        source: "ai",
        before: JSON.stringify(before),
        after: JSON.stringify({ markup: pct / 100 }),
      },
    });
    return { name, input, result: { markup: pct / 100 }, description };
  }

  if (name === "query_quantities") {
    const filter = input.filter as ToolFilter | undefined;
    const where = buildWhere(projectId, filter);
    const surfaces = await db.surface.findMany({ where });
    const totals = {
      surfaceCount: surfaces.length,
      squareFootage: surfaces.reduce(
        (a, s) => a + (s.squareFootage ?? 0),
        0,
      ),
      linearFootage: surfaces.reduce(
        (a, s) => a + (s.linearFootage ?? 0),
        0,
      ),
      itemCount: surfaces.reduce((a, s) => a + (s.count ?? 0), 0),
    };
    const description = `Queried ${surfaces.length} matching surface${surfaces.length === 1 ? "" : "s"}`;
    return { name, input, result: totals, description };
  }

  if (name === "set_measurement_mode") {
    const mode = (input.mode as string) ?? "net";
    const before = await db.project.findUnique({
      where: { id: projectId },
      select: { measurementMode: true },
    });
    await db.project.update({
      where: { id: projectId },
      data: { measurementMode: mode },
    });
    const description = `Set measurement mode to ${mode}`;
    await db.auditEntry.create({
      data: {
        projectId,
        action: description + ".",
        source: "ai",
        before: JSON.stringify(before),
        after: JSON.stringify({ measurementMode: mode }),
      },
    });
    return { name, input, result: { mode }, description };
  }

  if (name === "apply_assembly") {
    const assemblyId = input.assemblyId as string;
    const filter = input.filter as ToolFilter | undefined;
    const where = buildWhere(projectId, filter);
    const assembly = await db.toolChestItem.findUnique({
      where: { id: assemblyId },
    });
    if (!assembly) {
      return {
        name,
        input,
        result: { error: "Assembly not found." },
        description: "Couldn't find that saved assembly.",
      };
    }
    const result = await db.surface.updateMany({
      where,
      data: {
        paintType: assembly.paintType,
        coats: assembly.coats,
      },
    });
    const description = `Applied assembly "${assembly.name}" to ${result.count} surface${result.count === 1 ? "" : "s"}`;
    await db.auditEntry.create({
      data: {
        projectId,
        action: description + ".",
        source: "ai",
        after: JSON.stringify({ assemblyId, filter, count: result.count }),
      },
    });
    return {
      name,
      input,
      result: { applied: result.count },
      affectedCount: result.count,
      description,
    };
  }

  if (name === "recalculate_bid") {
    // Just signal — the worksheet recalculates client-side from fresh data.
    return {
      name,
      input,
      result: { ok: true },
      description: "Recalculated the bid.",
    };
  }

  if (name === "search_surfaces") {
    const query = (input.query ?? {}) as {
      roomLabelPattern?: string;
      surfaceType?: string;
      paintType?: string;
      substrate?: string;
      symbolType?: string;
    };
    const where: Record<string, unknown> = { projectId };
    if (query.symbolType) {
      where.type = `symbol:${query.symbolType}`;
    } else if (query.surfaceType) {
      where.type = query.surfaceType;
    }
    if (query.paintType) where.paintType = query.paintType;
    if (query.substrate) where.substrate = query.substrate;
    let surfaces = await db.surface.findMany({ where });
    if (query.roomLabelPattern) {
      const re = new RegExp(query.roomLabelPattern, "i");
      surfaces = surfaces.filter((s) => s.roomLabel && re.test(s.roomLabel));
    }
    return {
      name,
      input,
      result: {
        count: surfaces.length,
        sample: surfaces.slice(0, 10).map((s) => ({
          roomLabel: s.roomLabel,
          type: s.type,
          squareFootage: s.squareFootage,
          linearFootage: s.linearFootage,
          count: s.count,
          paintType: s.paintType,
        })),
      },
      affectedCount: surfaces.length,
      description: `Searched surfaces — ${surfaces.length} matched.`,
    };
  }

  if (name === "count_symbols") {
    const symType = input.symbolType as string;
    if (!symType) {
      return {
        name,
        input,
        result: { error: "symbolType is required" },
        description: "Symbol count requires a type.",
      };
    }
    const rows = await db.surface.findMany({
      where: { projectId, type: `symbol:${symType}` },
    });
    const total = rows.reduce((a, r) => a + (r.count ?? 0), 0);
    const byRoom: Record<string, number> = {};
    for (const r of rows) {
      const k = r.roomLabel ?? "(no room)";
      byRoom[k] = (byRoom[k] ?? 0) + (r.count ?? 0);
    }
    return {
      name,
      input,
      result: { type: symType, total, byRoom },
      affectedCount: total,
      description: `Counted ${total} ${symType.replace(/_/g, " ")}${total === 1 ? "" : "s"} across the project.`,
    };
  }

  return {
    name,
    input,
    result: { error: "Unknown tool." },
    description: `Couldn't execute ${name}.`,
  };
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ---- TEST MODE: deterministic command interpretation ----

async function runTestModeChat(
  projectId: string,
  body: z.infer<typeof bodySchema>,
): Promise<{
  assistantText: string;
  executions: ToolExecution[];
  pendingConfirmation: {
    token: string;
    summary: string;
    toolUse: { name: string; input: Record<string, unknown> };
  } | null;
}> {
  const msg = body.message.toLowerCase();
  const executions: ToolExecution[] = [];

  // Confirmation flow
  if (body.confirmBulkToken) {
    const pending = await db.chatMessage.findFirst({
      where: {
        projectId,
        role: "system",
        content: { contains: body.confirmBulkToken },
      },
      orderBy: { createdAt: "desc" },
    });
    if (pending) {
      const payload = JSON.parse(pending.content) as {
        token: string;
        toolUse: { name: string; input: Record<string, unknown> };
      };
      const ex = await executeTool(
        projectId,
        payload.toolUse.name,
        payload.toolUse.input,
      );
      executions.push(ex);
      return {
        assistantText: `Done. ${ex.description}.`,
        executions,
        pendingConfirmation: null,
      };
    }
  }

  // Pattern: "change all <room> walls to <paint type>"
  // or "change <room> walls to <paint>"
  const paintTypes = [
    "flat",
    "eggshell",
    "satin",
    "semi-gloss",
    "high-gloss",
    "epoxy",
    "anti-microbial primer",
  ];
  const room = msg.match(/\b(bathroom|patient room|corridor|lobby|hallway|kitchen|office)s?\b/);
  const paint = paintTypes.find((p) => msg.includes(p));
  const surfaceTypeMatch = msg.match(/\b(wall|ceiling|trim|door|window)s?\b/);

  if (
    (msg.includes("change") || msg.includes("update") || msg.includes("set")) &&
    paint
  ) {
    const filter: ToolFilter = {};
    if (room) filter.roomLabelPattern = capitalize(room[1]);
    if (surfaceTypeMatch)
      filter.surfaceType = surfaceTypeMatch[1] as ToolFilter["surfaceType"];
    const input = {
      filter,
      changes: { paintType: paint },
    };
    const count = await previewToolAffected(projectId, "update_surfaces", input);

    if (count > BULK_THRESHOLD) {
      const token = randomToken();
      const summary = summarizeTool("update_surfaces", input, count);
      await db.chatMessage.create({
        data: {
          projectId,
          role: "system",
          content: JSON.stringify({
            token,
            toolUse: { name: "update_surfaces", input },
          }),
        },
      });
      return {
        assistantText: `I'm ready to ${summary} — please confirm.`,
        executions: [],
        pendingConfirmation: {
          token,
          summary,
          toolUse: { name: "update_surfaces", input },
        },
      };
    }

    const ex = await executeTool(projectId, "update_surfaces", input);
    executions.push(ex);
    return {
      assistantText: `Done. ${ex.description}.`,
      executions,
      pendingConfirmation: null,
    };
  }

  // Pattern: "what's the total square footage?"
  if (
    msg.includes("total") &&
    (msg.includes("square") ||
      msg.includes("sqft") ||
      msg.includes("footage"))
  ) {
    const filter: ToolFilter = {};
    if (room) filter.roomLabelPattern = capitalize(room[1]);
    const ex = await executeTool(projectId, "query_quantities", { filter });
    executions.push(ex);
    const totals = ex.result as { squareFootage: number; surfaceCount: number };
    return {
      assistantText: `You have ${Math.round(totals.squareFootage)} square feet across ${totals.surfaceCount} surfaces.`,
      executions,
      pendingConfirmation: null,
    };
  }

  // Pattern: "exclude all <type>" / "exclude <room>"
  if (msg.includes("exclude")) {
    const filter: ToolFilter = {};
    if (room) filter.roomLabelPattern = capitalize(room[1]);
    if (surfaceTypeMatch)
      filter.surfaceType = surfaceTypeMatch[1] as ToolFilter["surfaceType"];
    const ex = await executeTool(projectId, "exclude_surfaces", { filter });
    executions.push(ex);
    return {
      assistantText: `Done. ${ex.description}.`,
      executions,
      pendingConfirmation: null,
    };
  }

  // Pattern: "set waste factor to N%"
  const wasteMatch = msg.match(/waste.*?(\d+)\s*%/);
  if (wasteMatch) {
    const pct = parseInt(wasteMatch[1], 10);
    const ex = await executeTool(projectId, "set_waste_factor", {
      percentage: pct,
    });
    executions.push(ex);
    return {
      assistantText: `Done. Waste factor is now ${pct}%.`,
      executions,
      pendingConfirmation: null,
    };
  }

  // Pattern: "set markup to N%" / "change markup to N%"
  const markupMatch = msg.match(/markup.*?(\d+)\s*%/);
  if (markupMatch) {
    const pct = parseInt(markupMatch[1], 10);
    const ex = await executeTool(projectId, "set_markup", {
      percentage: pct,
    });
    executions.push(ex);
    return {
      assistantText: `Done. Markup is now ${pct}%.`,
      executions,
      pendingConfirmation: null,
    };
  }

  return {
    assistantText:
      "I'm not sure what you meant. Try a command like \"change all bathroom walls to semi-gloss\" or \"what's the total square footage?\".",
    executions: [],
    pendingConfirmation: null,
  };
}

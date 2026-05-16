import { NextResponse } from "next/server";
import { mkdir, readFile, writeFile } from "fs/promises";
import { existsSync } from "fs";
import path from "node:path";
import { z } from "zod";
import { db } from "@/lib/db";
import { getAnthropic, MissingApiKeyError } from "@/lib/anthropic";
import { gateAiCall, trackApiUsage } from "@/lib/rate-limit";
import { getCached, hashBuffer, makeCacheKey, setCached } from "@/lib/cache";
import { SPECS_SYSTEM_PROMPT } from "@/lib/ai/specs-prompt";
import {
  DEFAULT_MODEL,
  MAX_SPEC_RUNS_PER_DOC_PER_DAY,
} from "@/lib/constants";
import {
  isTestMode,
  stubSpecAnalysis,
  type SpecAnalysisResponse,
} from "@/lib/ai/test-mode";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

const UPLOADS_DIR = path.join(process.cwd(), "uploads");

const querySchema = z.object({
  projectId: z.string().min(1),
});

async function ensureUploadsDir() {
  if (!existsSync(UPLOADS_DIR)) {
    await mkdir(UPLOADS_DIR, { recursive: true });
  }
}

export async function POST(req: Request) {
  try {
    await ensureUploadsDir();
    const form = await req.formData();
    const projectId = form.get("projectId");
    const file = form.get("file");

    if (typeof projectId !== "string" || !projectId) {
      return NextResponse.json(
        { error: "Missing project ID." },
        { status: 400 },
      );
    }
    if (!(file instanceof File)) {
      return NextResponse.json(
        { error: "Please choose a spec PDF to upload." },
        { status: 400 },
      );
    }
    if (!file.name.toLowerCase().endsWith(".pdf")) {
      return NextResponse.json(
        { error: "Only PDF files are supported." },
        { status: 400 },
      );
    }

    const project = await db.project.findUnique({ where: { id: projectId } });
    if (!project) {
      return NextResponse.json(
        { error: "Project not found." },
        { status: 404 },
      );
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const fileHash = hashBuffer(buffer);

    // Persist the file + create Spec row
    const filename = `${Date.now()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
    const filePath = path.join(UPLOADS_DIR, filename);
    await writeFile(filePath, buffer);

    const cacheKey = makeCacheKey({
      endpoint: "specs",
      model: DEFAULT_MODEL,
      prompt: SPECS_SYSTEM_PROMPT,
      inputHash: fileHash,
    });

    // Cache check first.
    const cached = await getCached<SpecAnalysisResponse>(cacheKey);
    if (cached) {
      const spec = await db.spec.create({
        data: {
          projectId,
          filename: file.name,
          filePath: filename,
          aiSummary: JSON.stringify(cached),
          flags: JSON.stringify(cached.flaggedRequirements ?? []),
        },
      });
      return NextResponse.json({
        cached: true,
        spec: { id: spec.id },
        response: cached,
      });
    }

    // Rate-limit gate.
    const gate = await gateAiCall({
      perCallerKey: `specs:${fileHash}`,
      perCallerMax: MAX_SPEC_RUNS_PER_DOC_PER_DAY,
      perCallerWindowSeconds: 24 * 60 * 60,
    });
    if (!gate.allowed) {
      return NextResponse.json({ error: gate.reason }, { status: gate.status });
    }

    let response: SpecAnalysisResponse | null = null;
    let inputTokens = 0;
    let outputTokens = 0;

    try {
      if (isTestMode()) {
        const stub = stubSpecAnalysis();
        response = stub.response;
        inputTokens = stub.inputTokens;
        outputTokens = stub.outputTokens;
      } else {
        const anthropic = getAnthropic();
        const message = await anthropic.messages.create({
          model: DEFAULT_MODEL,
          max_tokens: 4096,
          system: SPECS_SYSTEM_PROMPT,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "document",
                  source: {
                    type: "base64",
                    media_type: "application/pdf",
                    data: buffer.toString("base64"),
                  },
                },
                {
                  type: "text",
                  text: "Extract paint scope, finish schedule, flagged items, safety and material requirements, exclusions. Return only JSON.",
                },
              ],
            },
          ],
        });
        inputTokens = message.usage.input_tokens;
        outputTokens = message.usage.output_tokens;
        const textBlock = message.content.find((b) => b.type === "text");
        if (textBlock && textBlock.type === "text") {
          try {
            const stripped = textBlock.text
              .trim()
              .replace(/^```(?:json)?/i, "")
              .replace(/```$/i, "")
              .trim();
            response = JSON.parse(stripped) as SpecAnalysisResponse;
          } catch {
            response = null;
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
            "The AI couldn't analyze this spec right now. Try again in a minute.",
        },
        { status: 502 },
      );
    }

    if (!response) {
      return NextResponse.json(
        {
          error:
            "The AI returned an unexpected response. Please try this spec again.",
        },
        { status: 502 },
      );
    }

    await trackApiUsage("specs", DEFAULT_MODEL, inputTokens, outputTokens);
    await setCached(cacheKey, "specs", response);

    const spec = await db.spec.create({
      data: {
        projectId,
        filename: file.name,
        filePath: filename,
        aiSummary: JSON.stringify(response),
        flags: JSON.stringify(response.flaggedRequirements ?? []),
      },
    });

    return NextResponse.json({
      cached: false,
      spec: { id: spec.id },
      response,
    });
  } catch {
    return NextResponse.json(
      {
        error:
          "Something went wrong analyzing the spec. Try again, or refresh the page.",
      },
      { status: 500 },
    );
  }
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const projectId = searchParams.get("projectId");
  if (!projectId) {
    return NextResponse.json(
      { error: "Missing project ID." },
      { status: 400 },
    );
  }
  const specs = await db.spec.findMany({
    where: { projectId },
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json({
    specs: specs.map((s) => ({
      id: s.id,
      filename: s.filename,
      summary: s.aiSummary ? JSON.parse(s.aiSummary) : null,
      createdAt: s.createdAt.toISOString(),
    })),
  });
}

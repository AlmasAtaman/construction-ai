import { NextResponse } from "next/server";
import { mkdir, writeFile } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const UPLOADS_DIR = path.join(process.cwd(), "uploads");

async function ensureUploadsDir() {
  if (!existsSync(UPLOADS_DIR)) {
    await mkdir(UPLOADS_DIR, { recursive: true });
  }
}

async function countPdfPages(buffer: Buffer): Promise<number> {
  // Count "/Type /Page" occurrences excluding "/Pages". Good enough for
  // simple PDFs; if it fails we default to 1.
  try {
    const text = buffer.toString("latin1");
    const matches = text.match(/\/Type\s*\/Page(?!s)/g);
    if (matches && matches.length > 0) return matches.length;
    return 1;
  } catch {
    return 1;
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
        { error: "Missing project ID. Please refresh and try again." },
        { status: 400 },
      );
    }
    if (!(file instanceof File)) {
      return NextResponse.json(
        { error: "Please choose a PDF file to upload." },
        { status: 400 },
      );
    }
    if (!file.name.toLowerCase().endsWith(".pdf")) {
      return NextResponse.json(
        {
          error:
            "Only PDF files are supported. Please pick a PDF and try again.",
        },
        { status: 400 },
      );
    }

    const project = await db.project.findUnique({ where: { id: projectId } });
    if (!project) {
      return NextResponse.json(
        { error: "Project not found. Try refreshing the page." },
        { status: 404 },
      );
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const filename = `${Date.now()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
    const filePath = path.join(UPLOADS_DIR, filename);
    await writeFile(filePath, buffer);

    const pageCount = await countPdfPages(buffer);

    const plan = await db.plan.create({
      data: {
        projectId,
        filename: file.name,
        filePath: filename,
        pageCount,
        pages: {
          create: Array.from({ length: pageCount }, (_, i) => ({
            pageNumber: i + 1,
          })),
        },
      },
      include: { pages: { orderBy: { pageNumber: "asc" } } },
    });

    return NextResponse.json({
      plan: {
        id: plan.id,
        filename: plan.filename,
        pageCount: plan.pageCount,
        pages: plan.pages.map((p) => ({
          id: p.id,
          pageNumber: p.pageNumber,
        })),
      },
    });
  } catch {
    return NextResponse.json(
      {
        error:
          "Something went wrong uploading your blueprint. Try again, or refresh the page.",
      },
      { status: 500 },
    );
  }
}

import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

const createSchema = z.object({
  name: z.string().min(1, "Project name is required").max(200),
  clientName: z.string().max(200).optional(),
});

export async function GET() {
  const projects = await db.project.findMany({
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      name: true,
      clientName: true,
      status: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  return NextResponse.json({ projects });
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        {
          error:
            "Please give your project a name before continuing.",
        },
        { status: 400 },
      );
    }
    const project = await db.project.create({
      data: {
        name: parsed.data.name.trim(),
        clientName: parsed.data.clientName?.trim() || null,
      },
    });
    return NextResponse.json({ project }, { status: 201 });
  } catch {
    return NextResponse.json(
      {
        error:
          "Something went wrong creating your project. Try again, or refresh the page.",
      },
      { status: 500 },
    );
  }
}

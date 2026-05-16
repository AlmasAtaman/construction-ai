"use client";

import { useEffect, useRef } from "react";
import { useEditorStore } from "@/lib/store/editor-store";
import type { SurfaceDTO } from "@/types/surface";

interface Props {
  surfaceId: string;
  position: { x: number; y: number };
  onClose: () => void;
}

const PAINT_TYPES = [
  "flat latex",
  "eggshell latex",
  "satin latex",
  "semi-gloss latex",
  "high-gloss enamel",
  "semi-gloss epoxy",
  "anti-microbial primer",
];

const SUBSTRATES = ["drywall", "CMU", "wood", "metal", "concrete", "unknown"];

export function SurfaceContextMenu({ surfaceId, position, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const updateSurface = useEditorStore((s) => s.updateSurface);
  const removeSurface = useEditorStore((s) => s.removeSurface);
  const surface = useEditorStore((s) =>
    s.surfaces.find((x) => x.id === surfaceId),
  );

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [onClose]);

  if (!surface) return null;

  async function patch(change: Partial<SurfaceDTO>) {
    updateSurface(surfaceId, change);
    await fetch(`/api/surfaces/${surfaceId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(change),
    });
    onClose();
  }

  async function remove() {
    removeSurface(surfaceId);
    await fetch(`/api/surfaces/${surfaceId}`, { method: "DELETE" });
    onClose();
  }

  return (
    <div
      ref={ref}
      data-testid="surface-context-menu"
      className="fixed z-50 w-56 rounded-md border border-gray-200 bg-white py-1 text-sm shadow-lg"
      style={{ top: position.y, left: position.x }}
    >
      <MenuLabel>Paint type</MenuLabel>
      {PAINT_TYPES.map((pt) => (
        <button
          key={pt}
          className={`block w-full px-3 py-1.5 text-left hover:bg-gray-100 ${
            surface.paintType === pt ? "font-semibold text-blue-700" : ""
          }`}
          data-testid={`menu-paint-${pt}`}
          onClick={() => void patch({ paintType: pt })}
        >
          {pt}
        </button>
      ))}

      <MenuLabel>Coats</MenuLabel>
      <div className="px-3 pb-2">
        <div className="flex gap-1">
          {[1, 2, 3, 4].map((n) => (
            <button
              key={n}
              className={`h-7 w-7 rounded text-xs font-semibold ${
                surface.coats === n
                  ? "bg-blue-600 text-white"
                  : "bg-gray-100 text-gray-700 hover:bg-gray-200"
              }`}
              onClick={() => void patch({ coats: n })}
            >
              {n}
            </button>
          ))}
        </div>
      </div>

      <MenuLabel>Substrate</MenuLabel>
      {SUBSTRATES.map((s) => (
        <button
          key={s}
          className={`block w-full px-3 py-1.5 text-left hover:bg-gray-100 ${
            surface.substrate === s ? "font-semibold text-blue-700" : ""
          }`}
          onClick={() => void patch({ substrate: s })}
        >
          {s}
        </button>
      ))}

      <div className="my-1 border-t border-gray-200" />
      <button
        className="block w-full px-3 py-1.5 text-left text-red-700 hover:bg-red-50"
        data-testid="menu-delete"
        onClick={() => void remove()}
      >
        Delete this surface
      </button>
    </div>
  );
}

function MenuLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-gray-500">
      {children}
    </div>
  );
}

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

export interface RailPage {
  id: string;
  pageNumber: number;
  pageType?: string | null;
  hidden?: boolean;
}

/** Sheet types that are worth doing a takeoff on — surfaced at the top. */
const FLOOR_TYPES = new Set(["floor_plan", "rcp"]);

const TYPE_LABEL: Record<string, string> = {
  floor_plan: "Floor plan",
  rcp: "Ceiling plan",
  elevation: "Elevation",
  section: "Section",
  schedule: "Schedule",
  detail: "Detail",
  site_plan: "Site plan",
  cover: "Cover",
  other: "Other",
};

interface ClassifiedPage {
  pageId: string;
  pageNumber: number;
  pageType: string;
}

export interface PagePatch {
  pageType?: string;
  hidden?: boolean;
}

export function PageRail({
  planId,
  pages,
  currentPage,
  onSelect,
  onClassified,
  onPageUpdate,
}: {
  planId: string;
  pages: RailPage[];
  currentPage: number;
  onSelect: (pageNumber: number) => void;
  onClassified: (classified: ClassifiedPage[]) => void;
  onPageUpdate: (pageId: string, patch: PagePatch) => void;
}) {
  const [classifying, setClassifying] = useState(false);
  const [showOther, setShowOther] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const attemptedPlanId = useRef<string | null>(null);

  const onClassifiedRef = useRef(onClassified);
  onClassifiedRef.current = onClassified;
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const currentRef = useRef(currentPage);
  currentRef.current = currentPage;

  const needsClassify = pages.some((p) => p.pageType == null);

  useEffect(() => {
    if (attemptedPlanId.current === planId || !needsClassify) return;
    attemptedPlanId.current = planId;
    setClassifying(true);
    void (async () => {
      try {
        const res = await fetch(`/api/plans/${planId}/classify-pages`, {
          method: "POST",
        });
        if (!res.ok) return;
        const json = (await res.json()) as { pages: ClassifiedPage[] };
        onClassifiedRef.current(json.pages);
        // The jump-to-floor-plan is handled by the effect below, which fires
        // once classification is known (fresh OR cached on reload).
      } finally {
        setClassifying(false);
      }
    })();
  }, [planId, needsClassify]);

  // Once sheet types are known, land the user on the first floor plan instead
  // of a cover/schedule sheet — once per plan, so manual navigation sticks.
  const jumpedPlanId = useRef<string | null>(null);
  useEffect(() => {
    // Fire once per plan, as soon as floor plans are known and classification
    // isn't still running — even if a few pages failed to classify (so a
    // stray unclassified sheet doesn't strand the user on the cover page).
    if (jumpedPlanId.current === planId || classifying) return;
    const floors = pages
      .filter(
        (p) => p.pageType != null && FLOOR_TYPES.has(p.pageType) && !p.hidden,
      )
      .sort((a, b) => a.pageNumber - b.pageNumber);
    if (floors.length === 0) return; // no floor plan known yet; wait
    jumpedPlanId.current = planId;
    const curType = pages.find((p) => p.pageNumber === currentPage)?.pageType;
    if (!curType || !FLOOR_TYPES.has(curType)) {
      onSelectRef.current(floors[0].pageNumber);
    }
  }, [planId, classifying, pages, currentPage]);

  const updatePage = useCallback(
    (pageId: string, patch: PagePatch) => {
      onPageUpdate(pageId, patch); // optimistic
      void fetch(`/api/plan-pages/${pageId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
    },
    [onPageUpdate],
  );

  const visible = pages.filter((p) => !p.hidden);
  const hiddenPages = pages.filter((p) => p.hidden);
  const floorPages = visible.filter(
    (p) => p.pageType != null && FLOOR_TYPES.has(p.pageType),
  );
  const otherPages = visible.filter(
    (p) => p.pageType != null && !FLOOR_TYPES.has(p.pageType),
  );
  const unknownPages = visible.filter((p) => p.pageType == null);
  const fullyClassified = unknownPages.length === 0;

  const renderPage = useCallback(
    (p: RailPage, opts: { dim?: boolean; actions: ActionKind[] }) => (
      <li key={p.id} className="group/page relative">
        <button
          onClick={() => onSelect(p.pageNumber)}
          className={cn(
            "flex w-full items-center gap-2 rounded-[4px] px-2 py-1.5 pr-12 text-left text-[13px] transition-colors",
            currentPage === p.pageNumber
              ? "bg-[hsl(var(--brand-soft))] font-medium text-[hsl(var(--brand))]"
              : opts.dim
                ? "text-[hsl(var(--ink-3))] hover:bg-[hsl(var(--panel-2))]"
                : "text-[hsl(var(--ink-2))] hover:bg-[hsl(var(--panel-2))]",
          )}
          data-testid={`page-button-${p.pageNumber}`}
        >
          <span className="num inline-block w-5 text-[12px] text-[hsl(var(--ink-3))]">
            {p.pageNumber}
          </span>
          <span className="truncate">
            {p.pageType ? TYPE_LABEL[p.pageType] ?? "Page" : `Page ${p.pageNumber}`}
          </span>
        </button>
        <div className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5 opacity-0 transition-opacity group-hover/page:opacity-100 focus-within:opacity-100">
          {opts.actions.map((a) => (
            <PageActionButton
              key={a}
              kind={a}
              onClick={() => {
                if (a === "promote")
                  updatePage(p.id, { pageType: "floor_plan" });
                else if (a === "demote") updatePage(p.id, { pageType: "other" });
                else if (a === "hide") updatePage(p.id, { hidden: true });
                else if (a === "restore") updatePage(p.id, { hidden: false });
              }}
            />
          ))}
        </div>
      </li>
    ),
    [currentPage, onSelect, updatePage],
  );

  // Pre-classification (or no API key): flat list, never blocked.
  if (!fullyClassified && floorPages.length === 0 && hiddenPages.length === 0) {
    return (
      <div className="flex-1 overflow-y-auto py-2">
        {classifying && (
          <p className="px-3 pb-2 text-[11px] text-[hsl(var(--ink-3))]">
            Identifying sheets…
          </p>
        )}
        <ul className="space-y-0.5 px-1.5" data-testid="pages-list">
          {visible.map((p) => renderPage(p, { actions: ["hide"] }))}
        </ul>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto py-2" data-testid="pages-list">
      {floorPages.length > 0 && (
        <>
          <RailGroupLabel>
            Floor plans{classifying ? " · identifying…" : ""}
          </RailGroupLabel>
          <ul className="space-y-0.5 px-1.5">
            {floorPages.map((p) => renderPage(p, { actions: ["hide"] }))}
          </ul>
        </>
      )}

      {otherPages.length > 0 && (
        <div className="mt-2">
          <GroupToggle
            open={showOther}
            onClick={() => setShowOther((v) => !v)}
            label={`Other sheets (${otherPages.length})`}
            testId="toggle-other-pages"
          />
          {showOther && (
            <ul className="space-y-0.5 px-1.5">
              {otherPages.map((p) =>
                renderPage(p, { dim: true, actions: ["promote", "hide"] }),
              )}
            </ul>
          )}
        </div>
      )}

      {unknownPages.length > 0 && (
        <ul className="mt-1 space-y-0.5 px-1.5">
          {unknownPages.map((p) =>
            renderPage(p, { dim: true, actions: ["promote", "hide"] }),
          )}
        </ul>
      )}

      {hiddenPages.length > 0 && (
        <div className="mt-2">
          <GroupToggle
            open={showHidden}
            onClick={() => setShowHidden((v) => !v)}
            label={`Hidden (${hiddenPages.length})`}
            testId="toggle-hidden-pages"
          />
          {showHidden && (
            <ul className="space-y-0.5 px-1.5">
              {hiddenPages.map((p) =>
                renderPage(p, { dim: true, actions: ["restore"] }),
              )}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

type ActionKind = "promote" | "demote" | "hide" | "restore";

const ACTION_META: Record<ActionKind, { title: string; path: string }> = {
  promote: { title: "Mark as floor plan", path: "M12 19V5M5 12l7-7 7 7" },
  demote: { title: "Move to other sheets", path: "M12 5v14M5 12l7 7 7-7" },
  hide: {
    title: "Hide this sheet",
    path: "M3 3l18 18M10.6 10.6a2 2 0 002.8 2.8M9.4 5.1A9.5 9.5 0 0112 5c5 0 9 4.5 9 7a11 11 0 01-2.4 3.3M6.1 6.1A11 11 0 003 12c0 2.5 4 7 9 7a9.6 9.6 0 003.6-.7",
  },
  restore: { title: "Restore to list", path: "M3 12a9 9 0 109-9 9 9 0 00-7 3.4M3 3v4h4" },
};

function PageActionButton({
  kind,
  onClick,
}: {
  kind: ActionKind;
  onClick: () => void;
}) {
  const meta = ACTION_META[kind];
  return (
    <button
      type="button"
      title={meta.title}
      aria-label={meta.title}
      data-testid={`page-action-${kind}`}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="flex h-6 w-6 items-center justify-center rounded-[4px] bg-white/90 text-[hsl(var(--ink-3))] shadow-sm ring-1 ring-[hsl(var(--line))] hover:text-[hsl(var(--ink))]"
    >
      <svg
        viewBox="0 0 24 24"
        width="12"
        height="12"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d={meta.path} />
      </svg>
    </button>
  );
}

function GroupToggle({
  open,
  onClick,
  label,
  testId,
}: {
  open: boolean;
  onClick: () => void;
  label: string;
  testId?: string;
}) {
  return (
    <button
      onClick={onClick}
      data-testid={testId}
      className="flex w-full items-center gap-1.5 px-3 py-1 text-left"
    >
      <svg
        viewBox="0 0 24 24"
        width="11"
        height="11"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        className={cn(
          "text-[hsl(var(--ink-3))] transition-transform",
          open ? "rotate-0" : "-rotate-90",
        )}
      >
        <path d="m6 9 6 6 6-6" />
      </svg>
      <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-[hsl(var(--ink-3))]">
        {label}
      </span>
    </button>
  );
}

function RailGroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-3 pb-1 pt-0.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-[hsl(var(--ink-3))]">
      {children}
    </div>
  );
}

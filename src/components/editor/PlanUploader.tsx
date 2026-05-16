"use client";

import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { PlanData } from "./ProjectWorkspace";

export function PlanUploader({
  projectId,
  onUploaded,
}: {
  projectId: string;
  onUploaded: (plan: PlanData) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  function pickFile() {
    inputRef.current?.click();
  }

  async function uploadFile(file: File) {
    if (!file.name.toLowerCase().endsWith(".pdf")) {
      setError("Only PDF files are supported.");
      return;
    }
    setError(null);
    setUploading(true);
    setProgress(5);

    try {
      const form = new FormData();
      form.append("projectId", projectId);
      form.append("file", file);

      const xhr = new XMLHttpRequest();
      const result = await new Promise<{ plan: PlanData } | { error: string }>(
        (resolve) => {
          xhr.open("POST", "/api/upload");
          xhr.upload.onprogress = (evt) => {
            if (evt.lengthComputable) {
              const pct = Math.min(95, (evt.loaded / evt.total) * 95);
              setProgress(pct);
            }
          };
          xhr.onload = () => {
            try {
              const json = JSON.parse(xhr.responseText);
              if (xhr.status >= 200 && xhr.status < 300) {
                resolve(json);
              } else {
                resolve({
                  error:
                    json.error ??
                    "Something went wrong uploading. Try again.",
                });
              }
            } catch {
              resolve({
                error: "Something went wrong uploading. Try again.",
              });
            }
          };
          xhr.onerror = () =>
            resolve({ error: "Something went wrong uploading. Try again." });
          xhr.send(form);
        },
      );

      setProgress(100);
      if ("error" in result) {
        setError(result.error);
      } else {
        onUploaded(result.plan);
      }
    } catch {
      setError("Something went wrong uploading. Try again.");
    } finally {
      setUploading(false);
    }
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) void uploadFile(file);
  }

  return (
    <div
      data-testid="plan-uploader"
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
      className={`mx-auto w-full max-w-xl rounded-[8px] border-2 border-dashed bg-white p-10 text-center shadow-sm transition-colors ${
        dragOver
          ? "border-[hsl(var(--brand))] bg-[hsl(var(--brand-soft))]"
          : "border-[hsl(var(--line))]"
      }`}
    >
      <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-[8px] bg-[hsl(var(--brand-soft))] text-[hsl(var(--brand))]">
        <svg
          viewBox="0 0 24 24"
          width="22"
          height="22"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
        >
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12" />
        </svg>
      </div>

      <h3 className="text-[16px] font-semibold text-[hsl(var(--ink))]">
        Upload your blueprint
      </h3>
      <p className="mx-auto mt-1.5 max-w-sm text-[13px] text-[hsl(var(--ink-2))]">
        Drag and drop a PDF here, or click the button below. Larger files may
        take a few seconds.
      </p>

      <input
        ref={inputRef}
        type="file"
        accept="application/pdf,.pdf"
        className="hidden"
        data-testid="file-input"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void uploadFile(file);
        }}
      />

      <div className="mt-5">
        <Button
          size="lg"
          onClick={pickFile}
          disabled={uploading}
          data-testid="pick-file-button"
        >
          {uploading ? "Uploading…" : "Choose a PDF"}
        </Button>
      </div>

      {uploading && (
        <div
          className="mt-5"
          role="progressbar"
          aria-valuenow={Math.round(progress)}
          aria-valuemin={0}
          aria-valuemax={100}
          data-testid="upload-progress"
        >
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-[hsl(var(--panel-2))]">
            <div
              className="h-full bg-[hsl(var(--brand))] transition-all"
              style={{ width: `${progress}%` }}
            />
          </div>
          <p className="num mt-2 text-[12px] text-[hsl(var(--ink-2))]">
            Uploading… {Math.round(progress)}%
          </p>
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="mt-4 rounded-[4px] border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-800"
          data-testid="upload-error"
        >
          {error}
        </div>
      )}
    </div>
  );
}

"use client";

import { useMemo, useState } from "react";

type AttachmentView = {
  id: string;
  fileName?: string | null;
  mimeType?: string | null;
  archivePath?: string | null;
  metadata?: unknown;
};

function normalize(value?: string | null) {
  return (value ?? "").toLowerCase();
}

function isImage(attachment: AttachmentView) {
  const mime = normalize(attachment.mimeType);
  const name = normalize(attachment.fileName ?? attachment.archivePath);
  return mime.startsWith("image/") || /\.(png|jpe?g|gif|webp|bmp)$/i.test(name);
}

function isPdf(attachment: AttachmentView) {
  const mime = normalize(attachment.mimeType);
  const name = normalize(attachment.fileName ?? attachment.archivePath);
  return mime.includes("pdf") || /\.pdf$/i.test(name);
}

function isAudio(attachment: AttachmentView) {
  const mime = normalize(attachment.mimeType);
  const name = normalize(attachment.fileName ?? attachment.archivePath);
  return mime.startsWith("audio/") || /\.(aac|amr|flac|m4a|mp3|ogg|opus|wav|wma)$/i.test(name);
}

function isExcludedAttachment(attachment: AttachmentView) {
  const row =
    attachment.metadata && typeof attachment.metadata === "object" && !Array.isArray(attachment.metadata)
      ? (attachment.metadata as Record<string, unknown>)
      : {};
  const recovery =
    row.recovery && typeof row.recovery === "object" && !Array.isArray(row.recovery)
      ? (row.recovery as Record<string, unknown>)
      : {};
  return recovery.excluded === true;
}

export function MessageAttachmentGallery({ attachments }: { attachments: AttachmentView[] }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const visibleAttachments = useMemo(() => attachments.filter((attachment) => !isExcludedAttachment(attachment)), [attachments]);
  const hiddenCount = attachments.length - visibleAttachments.length;
  const active = useMemo(() => visibleAttachments.find((a) => a.id === openId) ?? null, [visibleAttachments, openId]);

  return (
    <>
      <div className="mt-2 flex flex-wrap gap-2">
        {visibleAttachments.slice(0, 8).map((attachment) => {
          const label = attachment.fileName ?? attachment.archivePath ?? "Anexo";
          if (isImage(attachment)) {
            return (
              <button
                key={attachment.id}
                type="button"
                onClick={() => setOpenId(attachment.id)}
                className="overflow-hidden rounded border border-zinc-300 bg-white dark:border-zinc-700 dark:bg-zinc-900"
                title={label}
              >
                <img
                  src={`/api/attachments/${attachment.id}/content`}
                  alt={label}
                  className="h-16 w-16 object-cover"
                  loading="lazy"
                />
              </button>
            );
          }

          if (isAudio(attachment)) {
            return (
              <button
                key={attachment.id}
                type="button"
                onClick={() => setOpenId(attachment.id)}
                className="rounded border border-zinc-300 bg-zinc-100 px-2 py-1 text-left text-[11px] text-zinc-700 hover:bg-zinc-200 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700"
                title={label}
              >
                ▶ {label}
              </button>
            );
          }

          return (
            <button
              key={attachment.id}
              type="button"
              onClick={() => setOpenId(attachment.id)}
              className="rounded border border-zinc-300 bg-zinc-100 px-2 py-1 text-left text-[11px] text-zinc-700 hover:bg-zinc-200 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700"
              title={label}
            >
              {label}
            </button>
          );
        })}
        {hiddenCount > 0 ? (
          <span className="rounded border border-zinc-200 bg-zinc-100 px-2 py-1 text-[11px] text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
            {hiddenCount} anexo(s) nao recuperavel(is) ocultado(s)
          </span>
        ) : null}
      </div>

      {active ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => setOpenId(null)}>
          <div
            className="max-h-[90vh] w-full max-w-5xl overflow-hidden rounded-lg bg-white shadow-xl dark:bg-zinc-900"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-zinc-200 px-3 py-2 dark:border-zinc-700">
              <p className="truncate text-sm font-medium">{active.fileName ?? active.archivePath ?? "Anexo"}</p>
              <div className="flex items-center gap-2">
                <a
                  href={`/api/attachments/${active.id}/content?download=1`}
                  className="rounded border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
                >
                  Download
                </a>
                <button
                  type="button"
                  onClick={() => setOpenId(null)}
                  className="rounded border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
                >
                  Fechar
                </button>
              </div>
            </div>

            <div className="max-h-[calc(90vh-48px)] overflow-auto p-3">
              {isImage(active) ? (
                <img
                  src={`/api/attachments/${active.id}/content`}
                  alt={active.fileName ?? "Imagem"}
                  className="max-h-[80vh] w-full object-contain"
                />
              ) : isAudio(active) ? (
                <audio controls preload="metadata" className="w-full">
                  <source src={`/api/attachments/${active.id}/content`} />
                </audio>
              ) : isPdf(active) ? (
                <iframe
                  title={active.fileName ?? "PDF"}
                  src={`/api/attachments/${active.id}/content`}
                  className="h-[80vh] w-full rounded border border-zinc-200 dark:border-zinc-700"
                />
              ) : (
                <div className="space-y-2 text-sm text-zinc-700 dark:text-zinc-200">
                  <p>Preview inline nao disponivel para este tipo de arquivo.</p>
                  <a href={`/api/attachments/${active.id}/content?download=1`} className="text-blue-700 hover:underline dark:text-blue-300">
                    Clique para baixar o arquivo
                  </a>
                </div>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

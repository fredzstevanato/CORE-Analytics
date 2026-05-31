import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { prisma } from "@core/db";
import { extractArchiveEntryToFile, scanUfdrArchive } from "@core/parsers";

function safeName(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export function contentTypeFromPath(filePath: string, mimeType?: string | null) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".gif") return "image/gif";
  if (ext === ".webp") return "image/webp";
  if (ext === ".bmp") return "image/bmp";
  if (ext === ".pdf") return "application/pdf";
  if (ext === ".txt") return "text/plain; charset=utf-8";
  if (ext === ".mp4") return "video/mp4";
  if (ext === ".mp3") return "audio/mpeg";
  if (ext === ".opus") return "audio/ogg";
  if (ext === ".m4a") return "audio/mp4";
  if (ext === ".aac") return "audio/aac";
  if (ext === ".flac") return "audio/flac";
  if (ext === ".amr") return "audio/amr";
  if (ext === ".wma") return "audio/x-ms-wma";
  if (ext === ".ogg") return "audio/ogg";
  if (ext === ".wav") return "audio/wav";
  if (mimeType && mimeType.includes("/")) return mimeType;
  return "application/octet-stream";
}

async function fileExists(filePath: string) {
  try {
    const info = await stat(filePath);
    return info.isFile();
  } catch {
    return false;
  }
}

async function markAttachmentUnrecoverable(input: {
  attachmentId: string;
  currentMetadata: unknown;
  reason: string;
}) {
  const base =
    input.currentMetadata && typeof input.currentMetadata === "object" && !Array.isArray(input.currentMetadata)
      ? (input.currentMetadata as Record<string, unknown>)
      : {};
  const recovery =
    base.recovery && typeof base.recovery === "object" && !Array.isArray(base.recovery)
      ? (base.recovery as Record<string, unknown>)
      : {};

  await prisma.attachment
    .update({
      where: { id: input.attachmentId },
      data: {
        path: null,
        archivePath: null,
        metadata: {
          ...base,
          recovery: {
            ...recovery,
            status: "NOT_RECOVERED",
            excluded: true,
            reason: input.reason,
            markedAt: new Date().toISOString(),
            markedBy: "api/attachments/content"
          }
        }
      }
    })
    .catch(() => undefined);
}

export async function resolveAttachmentAbsolutePath(attachmentId: string) {
  const attachment = await prisma.attachment.findUnique({
    where: { id: attachmentId },
    select: {
      id: true,
      fileName: true,
      mimeType: true,
      path: true,
      archivePath: true,
      metadata: true,
      evidence: {
        select: {
          id: true,
          caseId: true,
          originalPath: true
        }
      }
    }
  });
  if (!attachment || !attachment.evidence) {
    return { error: "Anexo nao encontrado.", status: 404 as const };
  }

  const storageRoot = path.resolve(process.env.STORAGE_ROOT ?? "./storage");
  const currentPath = attachment.path ? path.resolve(attachment.path) : undefined;

  if (currentPath && (await fileExists(currentPath))) {
    return {
      absolutePath: currentPath,
      mimeType: attachment.mimeType,
      fileName: attachment.fileName ?? path.basename(currentPath)
    };
  }

  const ufdrAbsolutePath = path.resolve(storageRoot, attachment.evidence.originalPath);
  if (!(await fileExists(ufdrAbsolutePath))) {
    await markAttachmentUnrecoverable({
      attachmentId: attachment.id,
      currentMetadata: attachment.metadata,
      reason: "UFDR_SOURCE_NOT_FOUND"
    });
    return { error: "Anexo descartado: UFDR original indisponivel para recuperacao.", status: 410 as const };
  }

  let archiveEntryPath = attachment.archivePath ?? undefined;
  if (!archiveEntryPath && attachment.metadata && typeof attachment.metadata === "object") {
    const row = attachment.metadata as Record<string, unknown>;
    const candidate =
      (typeof row.archivePath === "string" && row.archivePath.trim()) ||
      (typeof row.path === "string" && row.path.trim()) ||
      (typeof row.sourcePath === "string" && row.sourcePath.trim()) ||
      (typeof row.fullPath === "string" && row.fullPath.trim());
    if (candidate) archiveEntryPath = candidate;
  }

  if (!archiveEntryPath && attachment.fileName) {
    const scan = await scanUfdrArchive(ufdrAbsolutePath);
    const fileNameLower = attachment.fileName.toLowerCase();
    const matches = scan.files.filter((entry) => path.basename(entry).toLowerCase() === fileNameLower);
    if (matches.length === 1) {
      archiveEntryPath = matches[0];
    } else if (matches.length > 1) {
      const preferred = matches.find((entry) => /(^|[\\/])files[\\/]/i.test(entry)) ?? matches[0];
      archiveEntryPath = preferred;
    }
  }

  if (!archiveEntryPath) {
    await markAttachmentUnrecoverable({
      attachmentId: attachment.id,
      currentMetadata: attachment.metadata,
      reason: "MISSING_ARCHIVE_PATH"
    });
    return { error: "Anexo descartado: sem caminho de origem recuperavel no UFDR.", status: 410 as const };
  }

  const cacheDir = path.resolve(
    storageRoot,
    "derived",
    attachment.evidence.caseId,
    attachment.evidence.id,
    "preview-cache"
  );
  await mkdir(cacheDir, { recursive: true });

  const fallbackName = attachment.fileName ?? path.basename(archiveEntryPath);
  const extension = path.extname(fallbackName) || path.extname(archiveEntryPath);
  const cacheName = `${attachment.id}-${safeName(path.basename(fallbackName, path.extname(fallbackName)))}${extension}`;
  const cachePath = path.resolve(cacheDir, cacheName);

  if (!(await fileExists(cachePath))) {
    try {
      await extractArchiveEntryToFile({
        ufdrAbsolutePath,
        entryPath: archiveEntryPath,
        outputPath: cachePath
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await markAttachmentUnrecoverable({
        attachmentId: attachment.id,
        currentMetadata: {
          ...(attachment.metadata && typeof attachment.metadata === "object" && !Array.isArray(attachment.metadata)
            ? (attachment.metadata as Record<string, unknown>)
            : {}),
          extractionError: message
        },
        reason: /Entry not found in UFDR/i.test(message) ? "MISSING_IN_UFDR_ARCHIVE" : "EXTRACTION_FAILED"
      });
      return {
        error: /Entry not found in UFDR/i.test(message)
          ? "Arquivo nao existe mais no UFDR original. Anexo descartado do indice."
          : "Falha ao recuperar anexo no UFDR. Anexo marcado como nao recuperavel.",
        status: 404 as const
      };
    }
  }

  return {
    absolutePath: cachePath,
    mimeType: attachment.mimeType,
    fileName: attachment.fileName ?? path.basename(cachePath)
  };
}

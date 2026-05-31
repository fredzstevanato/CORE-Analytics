import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";
import yauzl from "yauzl";
import AdmZip from "adm-zip";
import { spawn } from "node:child_process";

const NODE_MAX_STRING_BYTES = 0x1fffffe8;
const CHILD_OUTPUT_ERROR_MAX_BYTES = 1024 * 1024;

export type UfdrArchiveScanResult = {
  files: string[];
  reportXmlPath?: string;
  reportXmlContent?: string;
  reportXmlContentError?: string;
};

export type AudioExtractionHint = {
  chatExternalId?: string;
  messageExternalId?: string;
  archivePath?: string;
  fileName?: string;
};

export type ExtractedAudioEntry = {
  archivePath: string;
  fileName: string;
  absolutePath: string;
  sizeBytes: number;
  chatExternalId?: string;
  messageExternalId?: string;
};

export type ArchiveEntryExtractionRequest = {
  entryPath: string;
  outputPath: string;
};

export type ArchiveEntryExtractionResult = ArchiveEntryExtractionRequest & {
  sizeBytes: number;
  error?: string;
};

async function listFilesRecursively(rootDir: string): Promise<string[]> {
  const root = path.resolve(rootDir);
  const out: string[] = [];

  async function walk(current: string) {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const abs = path.resolve(current, entry.name);
      if (entry.isDirectory()) {
        await walk(abs);
        continue;
      }
      const rel = path.relative(root, abs).replace(/\\/g, "/");
      if (rel.length > 0) out.push(rel);
    }
  }

  await walk(root);
  return out;
}

function resolveEntryPathInsideSource(input: { sourceRoot: string; entryPath: string }) {
  const sourceRoot = path.resolve(input.sourceRoot);
  const resolved = path.resolve(sourceRoot, input.entryPath);
  if (!resolved.startsWith(`${sourceRoot}${path.sep}`) && resolved !== sourceRoot) {
    throw new Error(`Entry path outside source root: ${input.entryPath}`);
  }
  return resolved;
}

async function readEntryAsUtf8(
  zip: yauzl.ZipFile,
  entry: yauzl.Entry,
  maxSizeBytes = getReportXmlMaxBytes()
): Promise<string> {
  if (entry.uncompressedSize > maxSizeBytes) {
    throw new Error(`Entry ${entry.fileName} exceeds ${maxSizeBytes} bytes.`);
  }
  const maxStringBytes = getReportXmlMaxStringBytes();
  if (entry.uncompressedSize > maxStringBytes) {
    throw new Error(
      `report.xml is too large for in-memory XML parsing (${entry.uncompressedSize} bytes > ${maxStringBytes}).`
    );
  }

  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (openError, stream) => {
      if (openError) {
        reject(openError);
        return;
      }
      if (!stream) {
        reject(new Error(`Failed to open stream for ${entry.fileName}`));
        return;
      }

      const chunks: Buffer[] = [];
      let size = 0;
      stream.on("data", (chunk: Buffer) => {
        size += chunk.byteLength;
        if (size > maxStringBytes) {
          stream.destroy(
            new Error(`report.xml is too large for in-memory XML parsing (${size} bytes > ${maxStringBytes}).`)
          );
          return;
        }
        chunks.push(chunk);
      });
      stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
      stream.on("error", reject);
    });
  });
}

async function readEntryAsBuffer(
  zip: yauzl.ZipFile,
  entry: yauzl.Entry,
  maxSizeBytes = 200 * 1024 * 1024
): Promise<Buffer> {
  if (entry.uncompressedSize > maxSizeBytes) {
    throw new Error(`Entry ${entry.fileName} exceeds ${maxSizeBytes} bytes.`);
  }

  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (openError, stream) => {
      if (openError) {
        reject(openError);
        return;
      }
      if (!stream) {
        reject(new Error(`Failed to open stream for ${entry.fileName}`));
        return;
      }
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("end", () => resolve(Buffer.concat(chunks)));
      stream.on("error", reject);
    });
  });
}

const AUDIO_EXTENSIONS = new Set([".aac", ".amr", ".flac", ".m4a", ".mp3", ".ogg", ".opus", ".wav", ".wma"]);
const TWO_GIB = 2 * 1024 * 1024 * 1024;

function isReportXmlPath(fileName: string) {
  return /(^|[\\/])report\.xml$/i.test(fileName);
}

function isAudioEntry(fileName: string) {
  const ext = path.extname(fileName).toLowerCase();
  return AUDIO_EXTENSIONS.has(ext);
}

function normalizeArchivePath(value: string) {
  return value.replace(/\\/g, "/").replace(/^\.\/+/, "").toLowerCase();
}

function findHint(fileName: string, hints: AudioExtractionHint[]): AudioExtractionHint | undefined {
  const basename = path.basename(fileName).toLowerCase();
  const normalizedFile = normalizeArchivePath(fileName);
  return hints.find((hint) => {
    const hintPath = hint.archivePath ? normalizeArchivePath(hint.archivePath) : undefined;
    const hintName = hint.fileName?.toLowerCase();
    return (hintPath && hintPath === normalizedFile) || (hintName && hintName === basename);
  });
}

function prioritizeAudioEntriesByHints(entries: string[], hints: AudioExtractionHint[]) {
  if (hints.length === 0) return entries;

  const hinted: string[] = [];
  const rest: string[] = [];
  for (const entry of entries) {
    if (findHint(entry, hints)) hinted.push(entry);
    else rest.push(entry);
  }

  if (hinted.length === 0) return entries;
  return [...hinted, ...rest];
}

function get7zBin() {
  return process.env.SEVEN_Z_BIN ?? process.env.UFDR_ARCHIVE_BIN ?? "7z";
}

async function shouldPrefer7z(ufdrAbsolutePath: string) {
  if (String(process.env.UFDR_FORCE_7Z ?? "").toLowerCase() === "true") {
    return true;
  }
  try {
    const info = await stat(ufdrAbsolutePath);
    return info.size >= TWO_GIB;
  } catch {
    return false;
  }
}

function getReportXmlMaxBytes() {
  const raw = process.env.REPORT_XML_MAX_BYTES;
  const parsed = raw ? Number(raw) : NaN;
  if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  return 512 * 1024 * 1024;
}

function getReportXmlMaxStringBytes() {
  const raw = process.env.REPORT_XML_MAX_STRING_BYTES;
  const parsed = raw ? Number(raw) : NaN;
  if (Number.isFinite(parsed) && parsed > 0) return Math.min(Math.floor(parsed), NODE_MAX_STRING_BYTES);
  return 256 * 1024 * 1024;
}

function get7zListMaxBytes() {
  const raw = process.env.UFDR_7Z_LIST_MAX_BYTES;
  const parsed = raw ? Number(raw) : NaN;
  if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  return 512 * 1024 * 1024;
}

async function run7zCapture(args: string[], maxBytes = 64 * 1024 * 1024): Promise<string> {
  const bin = get7zBin();
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stderr = "";
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      child.kill();
      child.stdout.destroy();
      reject(error);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      if (settled) return;
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > maxBytes) {
        fail(new Error(`7z output exceeded ${maxBytes} bytes.`));
        return;
      }
      stdoutChunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderrBytes >= CHILD_OUTPUT_ERROR_MAX_BYTES) return;
      const remaining = CHILD_OUTPUT_ERROR_MAX_BYTES - stderrBytes;
      stderr += chunk.subarray(0, remaining).toString();
      stderrBytes += Math.min(chunk.byteLength, remaining);
    });
    child.on("error", fail);
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (stdoutBytes > NODE_MAX_STRING_BYTES) {
        reject(new Error(`7z output is too large to decode as a Node.js string (${stdoutBytes} bytes).`));
        return;
      }
      const stdout = Buffer.concat(stdoutChunks).toString("utf-8");
      if (code === 0 || (code !== null && code <= 2 && stdoutBytes > 0)) resolve(stdout);
      else reject(new Error(`7z failed (${code}): ${stderr || stdout}`));
    });
  });
}

async function listEntriesWith7z(ufdrAbsolutePath: string): Promise<string[]> {
  const archiveAbs = path.resolve(ufdrAbsolutePath).toLowerCase();
  const maxBytes = get7zListMaxBytes();

  const parseConciseList = (raw: string) => {
    const out: string[] = [];
    for (const rawLine of raw.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      if (line.startsWith("7-Zip")) continue;
      if (line.startsWith("Scanning the drive")) continue;
      if (line.startsWith("Path = ")) continue;
      if (line === "--" || line === "----------") continue;
      if (/^Type = /i.test(line)) continue;
      if (/^Physical Size = /i.test(line)) continue;
      if (/^Headers Size = /i.test(line)) continue;
      if (/^Method = /i.test(line)) continue;
      if (/^Solid = /i.test(line)) continue;
      if (/^Blocks = /i.test(line)) continue;

      // 7z `l -ba` lines usually look like:
      // YYYY-MM-DD HH:MM:SS ATTR SIZE COMPRESSED NAME_WITH_SPACES
      // We need only NAME (last column block), which may contain spaces.
      const match =
        line.match(/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\s+\S+\s+\d+\s+\d+\s+(.+)$/) ??
        line.match(/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\s+\S+\s+\d+\s+(.+)$/);
      const entry = (match?.[1] ?? line).trim();
      if (!entry) continue;
      if (path.resolve(entry).toLowerCase() === archiveAbs) continue;
      out.push(entry);
    }
    return out;
  };

  // Prefer concise list mode to avoid giant stdout from `-slt` on big UFDRs.
  const concise = await run7zCapture(["l", "-ba", "-sccUTF-8", ufdrAbsolutePath], maxBytes).catch(() => "");
  const conciseRows = parseConciseList(concise);
  if (conciseRows.length > 0) {
    return conciseRows;
  }

  // Fallback: structured output parsing.
  const structured = await run7zCapture(["l", "-slt", "-ba", ufdrAbsolutePath], maxBytes);
  const rows = structured
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("Path = "))
    .map((line) => line.slice("Path = ".length).trim())
    .filter((value) => value.length > 0)
    .filter((entry) => path.resolve(entry).toLowerCase() !== archiveAbs);

  return rows;
}

async function readEntryAsUtf8With7z(ufdrAbsolutePath: string, entryPath: string): Promise<string> {
  const bin = get7zBin();
  const maxBytes = getReportXmlMaxBytes();
  const maxStringBytes = getReportXmlMaxStringBytes();
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ["x", "-so", ufdrAbsolutePath, entryPath], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let stderrBytes = 0;
    let stderr = "";
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      child.kill();
      child.stdout.destroy();
      reject(error);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      if (settled) return;
      size += chunk.byteLength;
      if (size > maxBytes) {
        fail(new Error(`report.xml extracted content exceeded ${maxBytes} bytes.`));
        return;
      }
      if (size > maxStringBytes) {
        fail(new Error(`report.xml is too large for in-memory XML parsing (${size} bytes > ${maxStringBytes}).`));
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderrBytes >= CHILD_OUTPUT_ERROR_MAX_BYTES) return;
      const remaining = CHILD_OUTPUT_ERROR_MAX_BYTES - stderrBytes;
      stderr += chunk.subarray(0, remaining).toString();
      stderrBytes += Math.min(chunk.byteLength, remaining);
    });
    child.on("error", fail);
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (code === 0 || (code !== null && code <= 2 && size > 0)) {
        resolve(Buffer.concat(chunks).toString("utf-8"));
      } else {
        reject(new Error(`7z read report.xml failed (${code}): ${stderr}`));
      }
    });
  });
}

async function extractEntryToFileWith7z(input: {
  ufdrAbsolutePath: string;
  entryPath: string;
  outputPath: string;
  signal?: AbortSignal;
}): Promise<number> {
  const bin = get7zBin();
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ["x", "-so", input.ufdrAbsolutePath, input.entryPath], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    const ws = createWriteStream(input.outputPath);
    let size = 0;
    let stderr = "";
    let childClosed = false;
    let childCode: number | null = null;
    let writeFinished = false;
    let settled = false;

    const cleanupAbort = () => input.signal?.removeEventListener("abort", onAbort);
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanupAbort();
      child.kill();
      ws.destroy();
      reject(error);
    };
    const maybeResolve = () => {
      if (settled || !childClosed || !writeFinished) return;
      settled = true;
      cleanupAbort();
      if (childCode === 0 || (childCode !== null && childCode <= 2 && size > 0)) resolve(size);
      else reject(new Error(`7z stream failed (${childCode}): ${stderr}`));
    };
    const onAbort = () => fail(new Error(`7z extraction aborted for entry: ${input.entryPath}`));

    if (input.signal?.aborted) {
      onAbort();
      return;
    }
    input.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;
    });
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("error", (error) => fail(error));
    child.on("close", (code) => {
      childClosed = true;
      childCode = code;
      maybeResolve();
    });
    ws.on("error", (error) => fail(error));
    ws.on("finish", () => {
      writeFinished = true;
      maybeResolve();
    });

    child.stdout.pipe(ws);
  });
}

async function run7zExtractToDirectory(input: {
  ufdrAbsolutePath: string;
  listFilePath: string;
  outputDir: string;
  signal?: AbortSignal;
}): Promise<void> {
  const bin = get7zBin();
  return new Promise((resolve, reject) => {
    const child = spawn(
      bin,
      ["x", "-y", "-bb0", "-sccUTF-8", "-scsUTF-8", `-o${input.outputDir}`, input.ufdrAbsolutePath, `@${input.listFilePath}`],
      {
        stdio: ["ignore", "ignore", "pipe"]
      }
    );
    let stderrBytes = 0;
    let stderr = "";
    let settled = false;
    const cleanupAbort = () => input.signal?.removeEventListener("abort", onAbort);
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanupAbort();
      child.kill();
      reject(error);
    };
    const onAbort = () => fail(new Error("7z batch extraction aborted."));

    if (input.signal?.aborted) {
      onAbort();
      return;
    }
    input.signal?.addEventListener("abort", onAbort, { once: true });

    child.stderr.on("data", (chunk: Buffer) => {
      if (stderrBytes >= CHILD_OUTPUT_ERROR_MAX_BYTES) return;
      const remaining = CHILD_OUTPUT_ERROR_MAX_BYTES - stderrBytes;
      stderr += chunk.subarray(0, remaining).toString();
      stderrBytes += Math.min(chunk.byteLength, remaining);
    });
    child.on("error", fail);
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      cleanupAbort();
      if (code === 0 || (code !== null && code <= 2)) {
        resolve();
      } else {
        reject(new Error(`7z batch extract failed (${code}): ${stderr}`));
      }
    });
  });
}

export async function scanUfdrArchive(ufdrAbsolutePath: string): Promise<UfdrArchiveScanResult> {
  const sourceStat = await stat(ufdrAbsolutePath);
  if (sourceStat.isDirectory()) {
    return scanUfdrDirectory(ufdrAbsolutePath);
  }
  if (await shouldPrefer7z(ufdrAbsolutePath)) {
    return scanUfdrArchive7z(ufdrAbsolutePath);
  }
  try {
    return await scanUfdrArchiveYauzl(ufdrAbsolutePath);
  } catch {
    try {
      return scanUfdrArchiveAdmZip(ufdrAbsolutePath);
    } catch {
      return scanUfdrArchive7z(ufdrAbsolutePath);
    }
  }
}

async function scanUfdrDirectory(sourceDir: string): Promise<UfdrArchiveScanResult> {
  const files = await listFilesRecursively(sourceDir);
  const reportXmlPath = files.find((file) => isReportXmlPath(file));
  if (!reportXmlPath) return { files };

  const reportXmlAbsolutePath = resolveEntryPathInsideSource({
    sourceRoot: sourceDir,
    entryPath: reportXmlPath
  });

  try {
    const info = await stat(reportXmlAbsolutePath);
    const maxBytes = getReportXmlMaxBytes();
    if (info.size > maxBytes) {
      return {
        files,
        reportXmlPath,
        reportXmlContentError: `Entry ${reportXmlPath} exceeds ${maxBytes} bytes.`
      };
    }

    const maxStringBytes = getReportXmlMaxStringBytes();
    if (info.size > maxStringBytes) {
      return {
        files,
        reportXmlPath,
        reportXmlContentError: `report.xml is too large for in-memory XML parsing (${info.size} bytes > ${maxStringBytes}).`
      };
    }

    const reportXmlContent = await readFile(reportXmlAbsolutePath, "utf-8");
    return { files, reportXmlPath, reportXmlContent };
  } catch (error) {
    return {
      files,
      reportXmlPath,
      reportXmlContentError: error instanceof Error ? error.message : "Could not read report.xml from directory source."
    };
  }
}

async function scanUfdrArchiveYauzl(ufdrAbsolutePath: string): Promise<UfdrArchiveScanResult> {
  return new Promise((resolve, reject) => {
    yauzl.open(ufdrAbsolutePath, { lazyEntries: true, autoClose: true }, (openError, zip) => {
      if (openError || !zip) {
        reject(openError ?? new Error("Could not open UFDR archive."));
        return;
      }

      const files: string[] = [];
      let reportXmlPath: string | undefined;
      let reportXmlContent: string | undefined;
      let reportXmlContentError: string | undefined;

      zip.readEntry();

      zip.on("entry", async (entry) => {
        const fileName = entry.fileName;
        files.push(fileName);

        try {
          if (!reportXmlPath && isReportXmlPath(fileName)) {
            reportXmlPath = fileName;
            try {
              reportXmlContent = await readEntryAsUtf8(zip, entry);
            } catch (error) {
              reportXmlContentError =
                error instanceof Error ? error.message : "Could not read report.xml into memory.";
            }
          }
          zip.readEntry();
        } catch (error) {
          reject(error);
        }
      });

      zip.on("end", () => {
        const result: UfdrArchiveScanResult = { files };
        if (reportXmlPath) result.reportXmlPath = reportXmlPath;
        if (reportXmlContent) result.reportXmlContent = reportXmlContent;
        if (reportXmlContentError) result.reportXmlContentError = reportXmlContentError;
        resolve(result);
      });

      zip.on("error", reject);
    });
  });
}

function scanUfdrArchiveAdmZip(ufdrAbsolutePath: string): UfdrArchiveScanResult {
  const zip = new AdmZip(ufdrAbsolutePath);
  const entries = zip.getEntries();
  const files = entries.map((entry: { entryName: string }) => entry.entryName);

  let reportXmlPath: string | undefined;
  let reportXmlContent: string | undefined;
  let reportXmlContentError: string | undefined;

  for (const entry of entries) {
    if (entry.isDirectory) continue;
    if (!reportXmlPath && isReportXmlPath(entry.entryName)) {
      reportXmlPath = entry.entryName;
      try {
        const data = entry.getData();
        const maxStringBytes = getReportXmlMaxStringBytes();
        if (data.byteLength > maxStringBytes) {
          throw new Error(`report.xml is too large for in-memory XML parsing (${data.byteLength} bytes > ${maxStringBytes}).`);
        }
        reportXmlContent = data.toString("utf-8");
      } catch (error) {
        reportXmlContentError =
          error instanceof Error ? error.message : "Could not read report.xml into memory.";
      }
      break;
    }
  }

  return {
    files,
    reportXmlPath,
    reportXmlContent,
    reportXmlContentError
  };
}

async function scanUfdrArchive7z(ufdrAbsolutePath: string): Promise<UfdrArchiveScanResult> {
  const files = await listEntriesWith7z(ufdrAbsolutePath);
  const reportXmlPath = files.find((name) => isReportXmlPath(name));
  let reportXmlContent: string | undefined;
  let reportXmlContentError: string | undefined;
  if (reportXmlPath) {
    try {
      reportXmlContent = await readEntryAsUtf8With7z(ufdrAbsolutePath, reportXmlPath);
    } catch (error) {
      reportXmlContentError =
        error instanceof Error ? error.message : "Could not read report.xml into memory.";
    }
  }

  return { files, reportXmlPath, reportXmlContent, reportXmlContentError };
}

async function extractEntryToFileYauzl(input: {
  ufdrAbsolutePath: string;
  entryPath: string;
  outputPath: string;
}): Promise<number> {
  return new Promise((resolve, reject) => {
    yauzl.open(input.ufdrAbsolutePath, { lazyEntries: true, autoClose: true }, (openError, zip) => {
      if (openError || !zip) {
        reject(openError ?? new Error("Could not open UFDR archive."));
        return;
      }

      let found = false;
      zip.readEntry();

      zip.on("entry", (entry) => {
        if (entry.fileName !== input.entryPath) {
          zip.readEntry();
          return;
        }
        found = true;
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            reject(streamError ?? new Error(`Could not open ${entry.fileName}`));
            return;
          }
          const ws = createWriteStream(input.outputPath);
          let size = 0;
          stream.on("data", (chunk: Buffer) => {
            size += chunk.byteLength;
          });
          stream.on("error", reject);
          ws.on("error", reject);
          ws.on("finish", () => resolve(size));
          stream.pipe(ws);
        });
      });

      zip.on("end", () => {
        if (!found) reject(new Error(`Entry not found in UFDR: ${input.entryPath}`));
      });
      zip.on("error", reject);
    });
  });
}

async function extractEntryToFileAdmZip(input: {
  ufdrAbsolutePath: string;
  entryPath: string;
  outputPath: string;
}): Promise<number> {
  const zip = new AdmZip(input.ufdrAbsolutePath);
  const entry = zip.getEntry(input.entryPath);
  if (!entry || entry.isDirectory) {
    throw new Error(`Entry not found in UFDR: ${input.entryPath}`);
  }
  const data = entry.getData();
  await writeFile(input.outputPath, data);
  return data.byteLength;
}

async function writeYauzlEntryToFile(input: {
  zip: yauzl.ZipFile;
  entry: yauzl.Entry;
  outputPath: string;
  signal?: AbortSignal;
}): Promise<number> {
  await mkdir(path.dirname(input.outputPath), { recursive: true });

  return new Promise((resolve, reject) => {
    if (input.signal?.aborted) {
      reject(new Error(`Extraction aborted for entry: ${input.entry.fileName}`));
      return;
    }

    input.zip.openReadStream(input.entry, (openError, stream) => {
      if (openError || !stream) {
        reject(openError ?? new Error(`Failed to open stream for ${input.entry.fileName}`));
        return;
      }

      const ws = createWriteStream(input.outputPath);
      let size = 0;
      let settled = false;
      const cleanupAbort = () => input.signal?.removeEventListener("abort", onAbort);
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanupAbort();
        stream.destroy();
        ws.destroy();
        reject(error);
      };
      const onAbort = () => fail(new Error(`Extraction aborted for entry: ${input.entry.fileName}`));

      input.signal?.addEventListener("abort", onAbort, { once: true });
      stream.on("data", (chunk: Buffer) => {
        size += chunk.byteLength;
      });
      stream.on("error", fail);
      ws.on("error", fail);
      ws.on("finish", () => {
        if (settled) return;
        settled = true;
        cleanupAbort();
        resolve(size);
      });
      stream.pipe(ws);
    });
  });
}

async function extractEntriesToFilesFromDirectory(input: {
  ufdrAbsolutePath: string;
  entries: ArchiveEntryExtractionRequest[];
}): Promise<ArchiveEntryExtractionResult[]> {
  const results: ArchiveEntryExtractionResult[] = [];

  for (const request of input.entries) {
    const outputPath = path.resolve(request.outputPath);
    try {
      const sourceEntryPath = resolveEntryPathInsideSource({
        sourceRoot: input.ufdrAbsolutePath,
        entryPath: request.entryPath
      });
      await mkdir(path.dirname(outputPath), { recursive: true });
      await copyFile(sourceEntryPath, outputPath);
      const info = await stat(outputPath);
      results.push({ ...request, outputPath, sizeBytes: Number(info.size) });
    } catch (error) {
      await rm(outputPath, { force: true }).catch(() => undefined);
      results.push({
        ...request,
        outputPath,
        sizeBytes: 0,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return results;
}

async function extractEntriesToFilesWith7z(input: {
  ufdrAbsolutePath: string;
  entries: ArchiveEntryExtractionRequest[];
  signal?: AbortSignal;
}): Promise<ArchiveEntryExtractionResult[]> {
  const firstOutputDir = path.dirname(path.resolve(input.entries[0]?.outputPath ?? "."));
  const tempDir = path.resolve(firstOutputDir, `.7z-batch-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`);
  const listFilePath = path.resolve(tempDir, "entries.txt");
  const normalizedOutputKey = (value: string) =>
    normalizeArchivePath(value)
      .replace(/^[a-z]:\/+/i, "")
      .replace(/^\/+/, "");

  try {
    await mkdir(tempDir, { recursive: true });
    await writeFile(listFilePath, input.entries.map((entry) => entry.entryPath).join("\n"), "utf-8");
    await run7zExtractToDirectory({
      ufdrAbsolutePath: input.ufdrAbsolutePath,
      listFilePath,
      outputDir: tempDir,
      signal: input.signal
    });

    const extractedFiles = await listFilesRecursively(tempDir);
    const extractedByKey = new Map<string, string>();
    for (const relativePath of extractedFiles) {
      if (normalizeArchivePath(relativePath) === "entries.txt") continue;
      extractedByKey.set(normalizedOutputKey(relativePath), path.resolve(tempDir, relativePath));
    }

    const results: ArchiveEntryExtractionResult[] = [];
    for (const request of input.entries) {
      const outputPath = path.resolve(request.outputPath);
      const key = normalizedOutputKey(request.entryPath);
      const extractedPath = extractedByKey.get(key);
      try {
        if (!extractedPath) {
          throw new Error(`Entry not extracted by 7z: ${request.entryPath}`);
        }
        await mkdir(path.dirname(outputPath), { recursive: true });
        await rename(extractedPath, outputPath).catch(async () => {
          await copyFile(extractedPath, outputPath);
          await rm(extractedPath, { force: true }).catch(() => undefined);
        });
        const info = await stat(outputPath);
        results.push({ ...request, outputPath, sizeBytes: Number(info.size) });
      } catch (error) {
        await rm(outputPath, { force: true }).catch(() => undefined);
        results.push({
          ...request,
          outputPath,
          sizeBytes: 0,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    return results;
  } catch (error) {
    return input.entries.map((request) => ({
      ...request,
      outputPath: path.resolve(request.outputPath),
      sizeBytes: 0,
      error: error instanceof Error ? error.message : String(error)
    }));
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function extractEntriesToFilesAdmZip(input: {
  ufdrAbsolutePath: string;
  entries: ArchiveEntryExtractionRequest[];
}): Promise<ArchiveEntryExtractionResult[]> {
  const zip = new AdmZip(input.ufdrAbsolutePath);
  const entriesByPath = new Map(zip.getEntries().map((entry) => [normalizeArchivePath(entry.entryName), entry]));
  const results: ArchiveEntryExtractionResult[] = [];

  for (const request of input.entries) {
    const outputPath = path.resolve(request.outputPath);
    try {
      const entry = entriesByPath.get(normalizeArchivePath(request.entryPath));
      if (!entry || entry.isDirectory) {
        throw new Error(`Entry not found in UFDR: ${request.entryPath}`);
      }
      const data = entry.getData();
      await mkdir(path.dirname(outputPath), { recursive: true });
      await writeFile(outputPath, data);
      results.push({ ...request, outputPath, sizeBytes: data.byteLength });
    } catch (error) {
      await rm(outputPath, { force: true }).catch(() => undefined);
      results.push({
        ...request,
        outputPath,
        sizeBytes: 0,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return results;
}

async function extractEntriesToFilesYauzl(input: {
  ufdrAbsolutePath: string;
  entries: ArchiveEntryExtractionRequest[];
  signal?: AbortSignal;
}): Promise<ArchiveEntryExtractionResult[]> {
  const requests = input.entries.map((request) => ({
    ...request,
    outputPath: path.resolve(request.outputPath)
  }));
  const pendingByPath = new Map<string, Array<{ index: number; request: ArchiveEntryExtractionRequest }>>();
  const results = new Array<ArchiveEntryExtractionResult | undefined>(requests.length);

  for (let index = 0; index < requests.length; index += 1) {
    const request = requests[index]!;
    const key = normalizeArchivePath(request.entryPath);
    const current = pendingByPath.get(key) ?? [];
    current.push({ index, request });
    pendingByPath.set(key, current);
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let zipRef: yauzl.ZipFile | undefined;

    const finish = () => {
      if (settled) return;
      settled = true;
      for (let index = 0; index < requests.length; index += 1) {
        const request = requests[index]!;
        if (results[index]) continue;
        results[index] = {
          ...request,
          sizeBytes: 0,
          error: `Entry not found in UFDR: ${request.entryPath}`
        };
      }
      resolve(results.map((result) => result!));
    };

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      zipRef?.close();
      reject(error);
    };

    yauzl.open(input.ufdrAbsolutePath, { lazyEntries: true, autoClose: true }, (openError, zip) => {
      if (openError || !zip) {
        fail(openError ?? new Error("Could not open UFDR archive."));
        return;
      }
      zipRef = zip;

      const readNext = () => {
        if (input.signal?.aborted) {
          fail(new Error("Batch extraction aborted."));
          return;
        }
        zip.readEntry();
      };

      zip.on("entry", (entry) => {
        const matches = pendingByPath.get(normalizeArchivePath(entry.fileName));
        if (!matches || matches.length === 0) {
          readNext();
          return;
        }
        pendingByPath.delete(normalizeArchivePath(entry.fileName));

        void (async () => {
          for (const match of matches) {
            try {
              const sizeBytes = await writeYauzlEntryToFile({
                zip,
                entry,
                outputPath: match.request.outputPath,
                signal: input.signal
              });
              results[match.index] = {
                ...match.request,
                sizeBytes
              };
            } catch (error) {
              await rm(match.request.outputPath, { force: true }).catch(() => undefined);
              results[match.index] = {
                ...match.request,
                sizeBytes: 0,
                error: error instanceof Error ? error.message : String(error)
              };
            }
          }
          readNext();
        })().catch((error) => fail(error instanceof Error ? error : new Error(String(error))));
      });
      zip.on("end", finish);
      zip.on("error", (error) => fail(error));
      readNext();
    });
  });
}

export async function extractArchiveEntriesToFiles(input: {
  ufdrAbsolutePath: string;
  entries: ArchiveEntryExtractionRequest[];
  signal?: AbortSignal;
}): Promise<ArchiveEntryExtractionResult[]> {
  if (input.entries.length === 0) return [];

  const sourceStat = await stat(input.ufdrAbsolutePath);
  if (sourceStat.isDirectory()) {
    return extractEntriesToFilesFromDirectory(input);
  }
  if (await shouldPrefer7z(input.ufdrAbsolutePath)) {
    return extractEntriesToFilesWith7z(input);
  }
  try {
    return await extractEntriesToFilesYauzl(input);
  } catch {
    try {
      return await extractEntriesToFilesAdmZip(input);
    } catch {
      return extractEntriesToFilesWith7z(input);
    }
  }
}

export async function extractArchiveEntryToFile(input: {
  ufdrAbsolutePath: string;
  entryPath: string;
  outputPath: string;
  signal?: AbortSignal;
}): Promise<number> {
  const sourceStat = await stat(input.ufdrAbsolutePath);
  if (sourceStat.isDirectory()) {
    const sourceEntryPath = resolveEntryPathInsideSource({
      sourceRoot: input.ufdrAbsolutePath,
      entryPath: input.entryPath
    });
    await copyFile(sourceEntryPath, input.outputPath);
    const info = await stat(input.outputPath);
    return Number(info.size);
  }
  if (await shouldPrefer7z(input.ufdrAbsolutePath)) {
    return extractEntryToFileWith7z(input);
  }
  try {
    return await extractEntryToFileYauzl(input);
  } catch {
    try {
      return await extractEntryToFileAdmZip(input);
    } catch {
      return extractEntryToFileWith7z(input);
    }
  }
}

export async function extractAudioEntriesFromUfdr(input: {
  ufdrAbsolutePath: string;
  outputDir: string;
  hints?: AudioExtractionHint[];
  maxFiles?: number;
  onProgress?: (input: { processed: number; total?: number; archivePath?: string }) => void;
}): Promise<ExtractedAudioEntry[]> {
  const sourceStat = await stat(input.ufdrAbsolutePath);
  if (sourceStat.isDirectory()) {
    return extractAudioEntriesFromDirectory(input);
  }
  if (await shouldPrefer7z(input.ufdrAbsolutePath)) {
    return extractAudioEntriesFromUfdr7z(input);
  }
  try {
    return await extractAudioEntriesFromUfdrYauzl(input);
  } catch {
    try {
      return extractAudioEntriesFromUfdrAdmZip(input);
    } catch {
      return extractAudioEntriesFromUfdr7z(input);
    }
  }
}

async function extractAudioEntriesFromDirectory(input: {
  ufdrAbsolutePath: string;
  outputDir: string;
  hints?: AudioExtractionHint[];
  maxFiles?: number;
  onProgress?: (input: { processed: number; total?: number; archivePath?: string }) => void;
}): Promise<ExtractedAudioEntry[]> {
  const hints = input.hints ?? [];
  const maxFiles =
    typeof input.maxFiles === "number" && Number.isFinite(input.maxFiles) && input.maxFiles > 0
      ? Math.floor(input.maxFiles)
      : undefined;

  const allFiles = await listFilesRecursively(input.ufdrAbsolutePath);
  const audioFilesBase = prioritizeAudioEntriesByHints(
    allFiles.filter((entryName) => isAudioEntry(entryName)),
    hints
  );
  const audioFiles = typeof maxFiles === "number" ? audioFilesBase.slice(0, maxFiles) : audioFilesBase;
  const collected: ExtractedAudioEntry[] = [];

  for (const entryName of audioFiles) {
    const absolutePath = resolveEntryPathInsideSource({
      sourceRoot: input.ufdrAbsolutePath,
      entryPath: entryName
    });
    const info = await stat(absolutePath);
    const base = path.basename(entryName).replace(/[^a-zA-Z0-9._-]/g, "_");
    const hint = findHint(entryName, hints);

    collected.push({
      archivePath: entryName,
      fileName: base,
      absolutePath,
      sizeBytes: Number(info.size),
      chatExternalId: hint?.chatExternalId,
      messageExternalId: hint?.messageExternalId
    });
    input.onProgress?.({ processed: collected.length, total: audioFiles.length, archivePath: entryName });
  }

  return collected;
}

async function extractAudioEntriesFromUfdrYauzl(input: {
  ufdrAbsolutePath: string;
  outputDir: string;
  hints?: AudioExtractionHint[];
  maxFiles?: number;
  onProgress?: (input: { processed: number; total?: number; archivePath?: string }) => void;
}): Promise<ExtractedAudioEntry[]> {
  const hints = input.hints ?? [];
  const maxFiles = typeof input.maxFiles === "number" && Number.isFinite(input.maxFiles) && input.maxFiles > 0
    ? Math.floor(input.maxFiles)
    : undefined;
  await mkdir(input.outputDir, { recursive: true });

  return new Promise((resolve, reject) => {
    yauzl.open(input.ufdrAbsolutePath, { lazyEntries: true, autoClose: true }, (openError, zip) => {
      if (openError || !zip) {
        reject(openError ?? new Error("Could not open UFDR archive."));
        return;
      }

      const collected: ExtractedAudioEntry[] = [];
      zip.readEntry();

      zip.on("entry", async (entry) => {
        try {
          if (!isAudioEntry(entry.fileName) || (typeof maxFiles === "number" && collected.length >= maxFiles)) {
            zip.readEntry();
            return;
          }

          const buffer = await readEntryAsBuffer(zip, entry);
          const base = path.basename(entry.fileName).replace(/[^a-zA-Z0-9._-]/g, "_");
          const outputName = `${Date.now()}-${collected.length}-${base}`;
          const outputPath = path.resolve(input.outputDir, outputName);
          await writeFile(outputPath, buffer);
          const hint = findHint(entry.fileName, hints);

          collected.push({
            archivePath: entry.fileName,
            fileName: base,
            absolutePath: outputPath,
            sizeBytes: buffer.byteLength,
            chatExternalId: hint?.chatExternalId,
            messageExternalId: hint?.messageExternalId
          });
          input.onProgress?.({ processed: collected.length, archivePath: entry.fileName });
          zip.readEntry();
        } catch (error) {
          reject(error);
        }
      });

      zip.on("end", () => resolve(collected));
      zip.on("error", reject);
    });
  });
}

async function extractAudioEntriesFromUfdrAdmZip(input: {
  ufdrAbsolutePath: string;
  outputDir: string;
  hints?: AudioExtractionHint[];
  maxFiles?: number;
  onProgress?: (input: { processed: number; total?: number; archivePath?: string }) => void;
}): Promise<ExtractedAudioEntry[]> {
  const hints = input.hints ?? [];
  const maxFiles = typeof input.maxFiles === "number" && Number.isFinite(input.maxFiles) && input.maxFiles > 0
    ? Math.floor(input.maxFiles)
    : undefined;
  await mkdir(input.outputDir, { recursive: true });

  const zip = new AdmZip(input.ufdrAbsolutePath);
  const entries = zip.getEntries();
  const collected: ExtractedAudioEntry[] = [];
  const allAudioEntries = entries.filter((entry) => !entry.isDirectory && isAudioEntry(entry.entryName));
  const orderedAudioEntryNamesBase = prioritizeAudioEntriesByHints(
    allAudioEntries.map((entry) => entry.entryName),
    hints
  );
  const orderedAudioEntryNames =
    typeof maxFiles === "number" ? orderedAudioEntryNamesBase.slice(0, maxFiles) : orderedAudioEntryNamesBase;
  const selectedSet = new Set(orderedAudioEntryNames.map((name) => normalizeArchivePath(name)));

  for (const entry of allAudioEntries) {
    if (!selectedSet.has(normalizeArchivePath(entry.entryName))) continue;
    if (typeof maxFiles === "number" && collected.length >= maxFiles) break;

    const buffer = entry.getData();
    const base = path.basename(entry.entryName).replace(/[^a-zA-Z0-9._-]/g, "_");
    const outputName = `${Date.now()}-${collected.length}-${base}`;
    const outputPath = path.resolve(input.outputDir, outputName);
    await writeFile(outputPath, buffer);
    const hint = findHint(entry.entryName, hints);

    collected.push({
      archivePath: entry.entryName,
      fileName: base,
      absolutePath: outputPath,
      sizeBytes: buffer.byteLength,
      chatExternalId: hint?.chatExternalId,
      messageExternalId: hint?.messageExternalId
    });
    input.onProgress?.({ processed: collected.length, total: orderedAudioEntryNames.length, archivePath: entry.entryName });
  }

  return collected;
}

async function extractAudioEntriesFromUfdr7z(input: {
  ufdrAbsolutePath: string;
  outputDir: string;
  hints?: AudioExtractionHint[];
  maxFiles?: number;
  onProgress?: (input: { processed: number; total?: number; archivePath?: string }) => void;
}): Promise<ExtractedAudioEntry[]> {
  const hints = input.hints ?? [];
  const maxFiles = typeof input.maxFiles === "number" && Number.isFinite(input.maxFiles) && input.maxFiles > 0
    ? Math.floor(input.maxFiles)
    : undefined;
  await mkdir(input.outputDir, { recursive: true });

  const files = await listEntriesWith7z(input.ufdrAbsolutePath);
  const audioFilesBase = prioritizeAudioEntriesByHints(
    files.filter((entryName) => isAudioEntry(entryName)),
    hints
  );
  const audioFiles = typeof maxFiles === "number" ? audioFilesBase.slice(0, maxFiles) : audioFilesBase;
  const collected: ExtractedAudioEntry[] = [];

  for (const entryName of audioFiles) {
    const base = path.basename(entryName).replace(/[^a-zA-Z0-9._-]/g, "_");
    const outputName = `${Date.now()}-${collected.length}-${base}`;
    const outputPath = path.resolve(input.outputDir, outputName);
    const sizeBytes = await extractEntryToFileWith7z({
      ufdrAbsolutePath: input.ufdrAbsolutePath,
      entryPath: entryName,
      outputPath
    });
    const hint = findHint(entryName, hints);

    collected.push({
      archivePath: entryName,
      fileName: base,
      absolutePath: outputPath,
      sizeBytes,
      chatExternalId: hint?.chatExternalId,
      messageExternalId: hint?.messageExternalId
    });
    input.onProgress?.({ processed: collected.length, total: audioFiles.length, archivePath: entryName });
  }

  return collected;
}

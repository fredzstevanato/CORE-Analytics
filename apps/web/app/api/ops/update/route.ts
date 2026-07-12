import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireApiRole, requireApiSession } from "@/lib/api-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type UpdateState = {
  running: boolean;
  startedAt: string | null;
  endedAt: string | null;
  exitCode: number | null;
  command: string;
  pid: number | null;
  logFile: string;
  lastError: string | null;
};

type UpdateCommand = {
  command: string;
  args: string[];
};

const startSchema = z.object({
  skipPull: z.boolean().optional().default(false),
  skipBackup: z.boolean().optional().default(false),
  healthTimeoutSeconds: z.number().int().min(60).max(1800).optional()
});

const storageRoot = process.env.STORAGE_ROOT ?? path.resolve(process.cwd(), "storage");
const opsDir = path.join(storageRoot, "tmp", "ops-update");
const statePath = path.join(opsDir, "state.json");
const logPath = path.join(opsDir, "update.log");

let inMemoryPid: number | null = null;

function defaultState(): UpdateState {
  return {
    running: false,
    startedAt: null,
    endedAt: null,
    exitCode: null,
    command: "",
    pid: null,
    logFile: logPath,
    lastError: null
  };
}

async function ensureOpsDir() {
  await fs.mkdir(opsDir, { recursive: true });
}

async function readState(): Promise<UpdateState> {
  try {
    const raw = await fs.readFile(statePath, "utf8");
    const parsed = JSON.parse(raw) as UpdateState;
    return { ...defaultState(), ...parsed, logFile: logPath };
  } catch {
    return defaultState();
  }
}

async function writeState(next: UpdateState) {
  await ensureOpsDir();
  await fs.writeFile(statePath, JSON.stringify(next, null, 2), "utf8");
}

async function appendLog(text: string) {
  await ensureOpsDir();
  await fs.appendFile(logPath, text, "utf8");
}

async function readTail(maxBytes = 120_000) {
  try {
    const stat = await fs.stat(logPath);
    const start = Math.max(0, stat.size - maxBytes);
    const handle = await fs.open(logPath, "r");
    try {
      const buffer = Buffer.alloc(stat.size - start);
      await handle.read(buffer, 0, buffer.length, start);
      return buffer.toString("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    return "";
  }
}

async function isRunningPid(pid: number | null) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function resolveUpdateCommand(input: z.infer<typeof startSchema>): Promise<UpdateCommand> {
  const platform = process.platform;

  if (platform === "win32") {
    const scriptPath = path.join(process.cwd(), "scripts", "update-core-analytics.ps1");
    await fs.access(scriptPath);

    const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "scripts/update-core-analytics.ps1"];
    if (input.skipPull) args.push("-SkipGitPull");
    if (input.skipBackup) args.push("-SkipBackup");
    if (input.healthTimeoutSeconds) args.push("-HealthTimeoutSeconds", String(input.healthTimeoutSeconds));

    return { command: "powershell", args };
  }

  const linuxScriptPath = path.join(process.cwd(), "scripts", "update-core-analytics.sh");
  await fs.access(linuxScriptPath);

  const args = ["scripts/update-core-analytics.sh"];
  if (input.skipPull) args.push("--skip-git-pull");
  if (input.skipBackup) args.push("--skip-backup");
  if (input.healthTimeoutSeconds) args.push("--health-timeout-seconds", String(input.healthTimeoutSeconds));

  return { command: "bash", args };
}

export async function GET() {
  const auth = await requireApiSession();
  if ("error" in auth) return auth.error;
  const role = requireApiRole(auth.session, ["ADMIN"]);
  if ("error" in role) return role.error;

  const state = await readState();
  const running = state.running && (await isRunningPid(state.pid));
  const tail = await readTail();

  if (state.running !== running) {
    state.running = running;
    if (!running && !state.endedAt) state.endedAt = new Date().toISOString();
    await writeState(state);
  }

  return NextResponse.json({ state, running, tail, platform: process.platform });
}

export async function POST(request: Request) {
  const auth = await requireApiSession();
  if ("error" in auth) return auth.error;
  const role = requireApiRole(auth.session, ["ADMIN"]);
  if ("error" in role) return role.error;

  const current = await readState();
  const runningNow = current.running && (await isRunningPid(current.pid));
  if (runningNow) {
    return NextResponse.json({ error: "Atualizacao ja em execucao." }, { status: 409 });
  }

  const parsed = startSchema.parse(await request.json().catch(() => ({})));

  let updateCmd: UpdateCommand;
  try {
    updateCmd = await resolveUpdateCommand(parsed);
  } catch {
    return NextResponse.json(
      {
        error:
          "Script de atualizacao nao encontrado para este sistema operacional. Verifique scripts/update-core-analytics.ps1 (Windows) ou scripts/update-core-analytics.sh (Linux)."
      },
      { status: 500 }
    );
  }

  await ensureOpsDir();
  await fs.writeFile(logPath, "", "utf8");

  const commandForState = [updateCmd.command, ...updateCmd.args].join(" ");
  const next: UpdateState = {
    running: true,
    startedAt: new Date().toISOString(),
    endedAt: null,
    exitCode: null,
    command: commandForState,
    pid: null,
    logFile: logPath,
    lastError: null
  };

  const child = spawn(updateCmd.command, updateCmd.args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: false
  });

  inMemoryPid = child.pid ?? null;
  next.pid = inMemoryPid;
  await writeState(next);
  await appendLog(`[${new Date().toISOString()}] START ${commandForState}\n`);

  child.stdout?.on("data", async (chunk: Buffer) => {
    await appendLog(chunk.toString("utf8"));
  });
  child.stderr?.on("data", async (chunk: Buffer) => {
    await appendLog(chunk.toString("utf8"));
  });

  child.on("error", async (error) => {
    const state = await readState();
    state.running = false;
    state.endedAt = new Date().toISOString();
    state.exitCode = -1;
    state.lastError = error.message;
    await appendLog(`[${new Date().toISOString()}] ERROR ${error.message}\n`);
    await writeState(state);
  });

  child.on("close", async (code) => {
    const state = await readState();
    state.running = false;
    state.endedAt = new Date().toISOString();
    state.exitCode = code ?? null;
    await appendLog(`[${new Date().toISOString()}] END exit=${code ?? "null"}\n`);
    await writeState(state);
  });

  return NextResponse.json({ ok: true, started: true, state: next });
}

import { spawn } from "node:child_process";
import { NextResponse } from "next/server";
import { requireApiSession } from "@/lib/api-auth";

export const runtime = "nodejs";

const PICK_TIMEOUT_MS = 5 * 60 * 1000;

function sourceRoot() {
  return process.env.UFDR_SOURCE_ROOT?.trim() || process.env.STORAGE_ROOT?.trim() || process.cwd();
}

function runPicker(command: string, args: string[]): Promise<{ filePath: string } | { cancelled: true }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: false });

    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("Tempo limite excedido ao abrir seletor de arquivo."));
    }, PICK_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        const filePath = stdout.trim();
        if (!filePath) {
          reject(new Error("Seletor retornou caminho vazio."));
          return;
        }
        resolve({ filePath });
        return;
      }
      if (code === 1 || code === 10) {
        resolve({ cancelled: true });
        return;
      }
      reject(new Error(stderr.trim() || `Falha ao abrir seletor nativo (codigo ${code ?? "desconhecido"}).`));
    });
  });
}

function pickUfdrPathOnWindows(): Promise<{ filePath: string } | { cancelled: true }> {
  const script = `
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = "Selecionar pasta da extracao UFDR descompactada (com report.xml)"
$dialog.ShowNewFolderButton = $false
$result = $dialog.ShowDialog()
if ($result -eq [System.Windows.Forms.DialogResult]::OK -and $dialog.SelectedPath) {
  Write-Output $dialog.SelectedPath
  exit 0
}
exit 10
`;

  return runPicker("powershell", ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-Command", script]);
}

async function pickUfdrPathOnLinux(): Promise<{ filePath: string } | { cancelled: true }> {
  const initialPath = sourceRoot();
  const attempts: Array<[string, string[]]> = [
    ["zenity", ["--file-selection", "--directory", "--title=Selecionar pasta da extracao UFDR", `--filename=${initialPath}/`]],
    ["kdialog", ["--title", "Selecionar pasta da extracao UFDR", "--getexistingdirectory", initialPath]],
    ["yad", ["--file-selection", "--directory", "--title=Selecionar pasta da extracao UFDR", `--filename=${initialPath}/`]]
  ];
  const errors: string[] = [];

  for (const [command, args] of attempts) {
    try {
      return await runPicker(command, args);
    } catch (error) {
      errors.push(`${command}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  throw new Error(
    `Nenhum seletor grafico Linux disponivel para escolher pasta UFDR. Instale zenity, kdialog ou yad; ou informe o caminho absoluto manualmente. Tentativas: ${errors.join(" | ")}`
  );
}

export async function POST() {
  try {
    const auth = await requireApiSession();
    if ("error" in auth) return auth.error;

    const result =
      process.platform === "win32"
        ? await pickUfdrPathOnWindows()
        : process.platform === "linux"
          ? await pickUfdrPathOnLinux()
          : await Promise.reject(new Error("Seletor nativo suportado apenas em Windows e Linux."));
    if ("cancelled" in result) {
      return NextResponse.json({ cancelled: true }, { status: 200 });
    }
    return NextResponse.json({ filePath: result.filePath }, { status: 200 });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Falha ao abrir seletor nativo."
      },
      { status: 500 }
    );
  }
}

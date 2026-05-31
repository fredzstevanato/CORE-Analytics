import { spawn } from "node:child_process";
import { NextResponse } from "next/server";
import { requireApiSession } from "@/lib/api-auth";

export const runtime = "nodejs";

const PICK_TIMEOUT_MS = 5 * 60 * 1000;

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

  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell",
      ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-Command", script],
      { windowsHide: false }
    );

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
      if (code === 10) {
        resolve({ cancelled: true });
        return;
      }
      reject(new Error(stderr.trim() || `Falha ao abrir seletor nativo (codigo ${code ?? "desconhecido"}).`));
    });
  });
}

export async function POST() {
  try {
    const auth = await requireApiSession();
    if ("error" in auth) return auth.error;

    if (process.platform !== "win32") {
      return NextResponse.json(
        { error: "Seletor nativo disponivel apenas no Windows neste ambiente." },
        { status: 409 }
      );
    }

    const result = await pickUfdrPathOnWindows();
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

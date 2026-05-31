import { getExtractionProgressPayload, type ExtractionProgressPayload } from "@/lib/extraction-progress";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      let interval: ReturnType<typeof setInterval> | null = null;
      const close = () => {
        if (!closed) {
          closed = true;
          if (interval) {
            clearInterval(interval);
            interval = null;
          }
          try {
            controller.close();
          } catch {
            // stream already closed
          }
        }
      };

      const write = (event: string, data: unknown) => {
        if (closed) return false;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\n`));
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
          return true;
        } catch {
          close();
          return false;
        }
      };

      const sendSnapshot = async () => {
        const payload: ExtractionProgressPayload | null = await getExtractionProgressPayload(params.id);
        if (!payload) {
          write("error", { message: "Extraction not found." });
          close();
          return;
        }

        if (!write("progress", payload)) return;
        const transcriptionsPending = payload.stats?.transcriptions?.pending ?? 0;
        const transcriptionsProcessing = payload.stats?.transcriptions?.processing ?? 0;
        const hasActiveBackgroundWork = transcriptionsPending > 0 || transcriptionsProcessing > 0;
        const isTerminal = payload.status === "COMPLETED" || payload.status === "FAILED";

        if (isTerminal && !hasActiveBackgroundWork) {
          write("done", payload);
          close();
        }
      };

      if (!write("ready", { ok: true })) return;
      await sendSnapshot();
      if (closed) return;

      interval = setInterval(async () => {
        if (closed) {
          if (interval) clearInterval(interval);
          return;
        }
        try {
          await sendSnapshot();
          if (closed && interval) clearInterval(interval);
        } catch {
          if (!closed) {
            write("error", { message: "Stream update failed." });
          }
          if (interval) clearInterval(interval);
          close();
        }
      }, 1500);
    },
    cancel() {
      return;
    }
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive"
    }
  });
}

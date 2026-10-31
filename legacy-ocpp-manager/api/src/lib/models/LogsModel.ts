import { join } from "node:path";
import { mkdir, readdir, stat, readFile } from "node:fs/promises";
import { ReadableStream } from "node:stream/web";
import { logDir } from "../globals/logger";

export class LogsModel {
  static async streamLogs(
    maxLines?: number
  ): Promise<ReadableStream<Uint8Array>> {
    await mkdir(logDir, { recursive: true });

    const files = await this.getSortedLogFiles();

    files.reverse();

    async function* streamGenerator() {
      const encoder = new TextEncoder();
      let totalLinesStreamed = 0;

      for (const file of files) {
        if (maxLines !== undefined && totalLinesStreamed >= maxLines) {
          break;
        }

        const filePath = join(logDir, file);
        let lastSize = 0;
        let stable = false;
        let stableCount = 0;

        while (!stable) {
          try {
            const stats = await stat(filePath);
            const currentSize = stats.size;

            if (currentSize === lastSize) {
              stableCount++;
              if (stableCount >= 3) {
                stable = true;
              }
            } else {
              stableCount = 0;
              lastSize = currentSize;
            }

            const content = await readFile(filePath, "utf8");
            const lines = content.split("\n").filter((line) => line.trim());
            lines.reverse();

            const remainingLines =
              maxLines !== undefined
                ? maxLines - totalLinesStreamed
                : lines.length;

            if (remainingLines <= 0) {
              break;
            }

            const selectedLines = lines.slice(0, remainingLines);
            totalLinesStreamed += selectedLines.length;

            const output = selectedLines.join("\n") + "\n";
            if (output.trim()) {
              yield encoder.encode(output);
            }

            if (!stable) {
              await new Promise((resolve) => setTimeout(resolve, 100));
            }
          } catch (error: any) {
            if (error.code === "EACCES") {
              throw error;
            }

            await new Promise((resolve) => setTimeout(resolve, 100));
          }
        }
      }
    }

    return new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          for await (const chunk of streamGenerator()) {
            controller.enqueue(chunk);
          }
          controller.close();
        } catch (error) {
          controller.error(error);
        }
      },
    });
  }

  private static async getSortedLogFiles(): Promise<string[]> {
    const entries: string[] = [];

    for (const entry of await readdir(logDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".log")) {
        entries.push(entry.name);
      }
    }

    return entries.sort((a, b) => {
      const dateA = a.split(".")[0];
      const dateB = b.split(".")[0];
      return new Date(dateA).getTime() - new Date(dateB).getTime();
    });
  }
}

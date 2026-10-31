import { promises as fs } from "fs";
import path from "path";

const logDir: string = path.join(process.cwd(), "logs");

export class LogsModel {
  static RETRY_DELAY = 100; // ms
  static MAX_RETRIES = 5;

  static async showLatestLines(linesCount: number = 100): Promise<string[]> {
    await this.ensureDir(logDir);
    const latestLog = await this.getLatestLogFile();
    if (!latestLog) return [];

    const filePath = path.join(logDir, latestLog);
    let attempts = 0;
    let lines: string[] = [];

    while (attempts < this.MAX_RETRIES) {
      try {
        const fileContent: string = await fs.readFile(filePath, "utf8");
        lines = fileContent
          .split("\n")
          .filter((line: string) => line.trim())
          .slice(-linesCount);

        if (lines.length > 0) break;
        await this.delay(this.RETRY_DELAY);
        attempts++;
      } catch (error) {
        if (error instanceof Error && error.message.includes("EACCES"))
          throw error;
        await this.delay(this.RETRY_DELAY);
        attempts++;
      }
    }

    return lines;
  }

  static async downloadAllAsStream(): Promise<ReadableStream<Uint8Array>> {
    await this.ensureDir(logDir);
    const files: string[] = await this.getSortedLogFiles();

    async function* streamGenerator() {
      for (const file of files) {
        const filePath: string = path.join(logDir, file);
        let lastSize = 0;
        let stable = false;
        let stableCount = 0;

        while (!stable) {
          try {
            const stats = await fs.stat(filePath);
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

            const content: string = await fs.readFile(filePath, "utf8");
            yield Buffer.from(content);

            if (!stable) {
              await LogsModel.delay(100);
            }
          } catch (error) {
            if (error instanceof Error && error.message.includes("EACCES"))
              throw error;
            await LogsModel.delay(100);
          }
        }

        yield Buffer.from("\n");
      }
    }

    return new ReadableStream({
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

  static async getLatestLogFile(): Promise<string | null> {
    const files: string[] = await this.getSortedLogFiles();
    return files.length > 0 ? files[files.length - 1] : null;
  }

  static async getSortedLogFiles(): Promise<string[]> {
    const entries: string[] = [];
    const dirContents = await fs.readdir(logDir, { withFileTypes: true });

    for (const entry of dirContents) {
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

  static async ensureDir(dirPath: string): Promise<void> {
    try {
      await fs.mkdir(dirPath, { recursive: true });
    } catch (error) {
      if (error instanceof Error && error.message.includes("EEXIST")) {
        return;
      } else {
        throw error;
      }
    }
  }

  static delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

import { Socket } from "node:net";
import type { Readable } from "node:stream";
import { ScannerUnavailableError, type MalwareScanner, type ScanContext, type ScanVerdict } from "./malware-scanner.js";

export interface ClamAvOptions {
  host: string;
  port: number;
  timeoutMs: number;
  chunkBytes?: number;
}

const MAX_RESPONSE_BYTES = 4096;

export function parseClamAvResponse(raw: string): ScanVerdict {
  const reply = raw.replace(/\0/g, "").trim();
  const payload = reply.replace(/^stream:\s*/i, "");
  if (/^OK$/i.test(payload)) return { status: "clean" };
  const infected = /^(.+)\s+FOUND$/i.exec(payload);
  if (infected) return { status: "infected", signature: infected[1]!.trim().slice(0, 200) };
  throw new ScannerUnavailableError(`Unexpected antivirus response: ${reply.slice(0, 200)}`);
}

export class ClamAvScanner implements MalwareScanner {
  readonly name = "clamav";
  readonly enabled = true;
  private readonly chunkBytes: number;

  constructor(private readonly options: ClamAvOptions) {
    this.chunkBytes = options.chunkBytes ?? 64 * 1024;
  }

  private connect(): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const socket = new Socket();
      socket.setTimeout(this.options.timeoutMs);
      const fail = (error: Error) => {
        socket.destroy();
        reject(new ScannerUnavailableError(`Antivirus connection failed: ${error.message}`));
      };
      socket.once("error", fail);
      socket.once("timeout", () => fail(new Error("timeout")));
      socket.connect(this.options.port, this.options.host, () => {
        socket.removeListener("error", fail);
        resolve(socket);
      });
    });
  }

  private readReply(socket: Socket): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let total = 0;
      socket.on("data", (chunk: Buffer) => {
        total += chunk.length;
        if (total > MAX_RESPONSE_BYTES) {
          socket.destroy();
          reject(new ScannerUnavailableError("Antivirus response too large"));
          return;
        }
        chunks.push(chunk);
        if (chunk.includes(0)) socket.end();
      });
      socket.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      socket.once("close", () => resolve(Buffer.concat(chunks).toString("utf8")));
      socket.once("error", (error) => reject(new ScannerUnavailableError(`Antivirus stream failed: ${error.message}`)));
      socket.once("timeout", () => {
        socket.destroy();
        reject(new ScannerUnavailableError("Antivirus timed out"));
      });
    });
  }

  private write(socket: Socket, data: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      socket.write(data, (error) => (error ? reject(new ScannerUnavailableError(`Antivirus write failed: ${error.message}`)) : resolve()));
    });
  }

  async scan(stream: Readable, _context: ScanContext): Promise<ScanVerdict> {
    const socket = await this.connect();
    const reply = this.readReply(socket);
    reply.catch(() => undefined);
    try {
      await this.write(socket, Buffer.from("zINSTREAM\0", "utf8"));
      for await (const piece of stream) {
        const buffer = Buffer.isBuffer(piece) ? piece : Buffer.from(piece as Uint8Array);
        for (let offset = 0; offset < buffer.length; offset += this.chunkBytes) {
          const slice = buffer.subarray(offset, offset + this.chunkBytes);
          const header = Buffer.alloc(4);
          header.writeUInt32BE(slice.length, 0);
          await this.write(socket, Buffer.concat([header, slice]));
        }
      }
      await this.write(socket, Buffer.alloc(4));
    } catch (error) {
      socket.destroy();
      stream.destroy();
      if (error instanceof ScannerUnavailableError) throw error;
      throw new ScannerUnavailableError(`Antivirus scan failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const raw = await reply;
    if (/size limit exceeded/i.test(raw)) throw new ScannerUnavailableError("Antivirus stream size limit exceeded");
    return parseClamAvResponse(raw);
  }

  async ping(): Promise<boolean> {
    try {
      const socket = await this.connect();
      const reply = this.readReply(socket);
      await this.write(socket, Buffer.from("zPING\0", "utf8"));
      return (await reply).replace(/\0/g, "").trim() === "PONG";
    } catch {
      return false;
    }
  }
}

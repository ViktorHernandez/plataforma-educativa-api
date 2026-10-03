import { createServer, type Server, type Socket } from "node:net";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { ClamAvScanner, parseClamAvResponse } from "../../src/core/antivirus/clamav-scanner.js";
import { ScannerUnavailableError } from "../../src/core/antivirus/malware-scanner.js";

const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";

interface FakeClamd {
  server: Server;
  port: number;
  received: Buffer[];
}

function readInstream(buffer: Buffer): { command: string; payload: Buffer } | null {
  const commandEnd = buffer.indexOf(0);
  if (commandEnd < 0) return null;
  const command = buffer.subarray(0, commandEnd).toString("utf8");
  if (command === "zPING") return { command, payload: Buffer.alloc(0) };
  let offset = commandEnd + 1;
  const chunks: Buffer[] = [];
  for (;;) {
    if (buffer.length < offset + 4) return null;
    const length = buffer.readUInt32BE(offset);
    offset += 4;
    if (length === 0) return { command, payload: Buffer.concat(chunks) };
    if (buffer.length < offset + length) return null;
    chunks.push(buffer.subarray(offset, offset + length));
    offset += length;
  }
}

async function startFakeClamd(): Promise<FakeClamd> {
  const received: Buffer[] = [];
  const server = createServer((socket: Socket) => {
    let data = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      data = Buffer.concat([data, chunk]);
      const parsed = readInstream(data);
      if (!parsed) return;
      if (parsed.command === "zPING") {
        socket.end("PONG\0");
        return;
      }
      received.push(parsed.payload);
      socket.end(parsed.payload.toString("utf8").includes("EICAR-STANDARD-ANTIVIRUS-TEST-FILE") ? "stream: Eicar-Test-Signature FOUND\0" : "stream: OK\0");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return { server, port: typeof address === "object" && address ? address.port : 0, received };
}

let fake: FakeClamd | null = null;

afterEach(async () => {
  if (fake) await new Promise<void>((resolve) => fake!.server.close(() => resolve()));
  fake = null;
});

describe("ClamAV INSTREAM scanner", () => {
  it("streams content in chunks and reports clean files", async () => {
    fake = await startFakeClamd();
    const scanner = new ClamAvScanner({ host: "127.0.0.1", port: fake.port, timeoutMs: 5000, chunkBytes: 7 });
    const content = Buffer.from("contenido académico inocuo ".repeat(50), "utf8");
    const verdict = await scanner.scan(Readable.from([content.subarray(0, 100), content.subarray(100)]), { fileId: "f", sizeBytes: content.length, mimeType: "text/plain" });
    expect(verdict).toEqual({ status: "clean" });
    expect(fake.received[0]!.equals(content)).toBe(true);
    expect(await scanner.ping()).toBe(true);
  });

  it("detects the EICAR test signature", async () => {
    fake = await startFakeClamd();
    const scanner = new ClamAvScanner({ host: "127.0.0.1", port: fake.port, timeoutMs: 5000 });
    const verdict = await scanner.scan(Readable.from([Buffer.from(EICAR)]), { fileId: "f", sizeBytes: EICAR.length, mimeType: "text/plain" });
    expect(verdict).toEqual({ status: "infected", signature: "Eicar-Test-Signature" });
  });

  it("reports an unavailable scanner so the worker retries", async () => {
    const scanner = new ClamAvScanner({ host: "127.0.0.1", port: 1, timeoutMs: 2000 });
    await expect(scanner.scan(Readable.from([Buffer.from("x")]), { fileId: "f", sizeBytes: 1, mimeType: "text/plain" })).rejects.toBeInstanceOf(ScannerUnavailableError);
    expect(await scanner.ping()).toBe(false);
  });

  it("parses clamd replies strictly", () => {
    expect(parseClamAvResponse("stream: OK\0")).toEqual({ status: "clean" });
    expect(parseClamAvResponse("stream: Win.Test.EICAR_HDB-1 FOUND\0")).toEqual({ status: "infected", signature: "Win.Test.EICAR_HDB-1" });
    expect(() => parseClamAvResponse("INSTREAM size limit exceeded. ERROR")).toThrow(ScannerUnavailableError);
    expect(() => parseClamAvResponse("")).toThrow(ScannerUnavailableError);
  });
});

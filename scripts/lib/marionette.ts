import { connect, type Socket } from 'node:net';

/**
 * Minimal Marionette client for the Firefox smoke harness (web-ext installs the extension and
 * runs headless Firefox; this client drives it).
 *
 * Wire protocol (verified against Firefox 155, chrome://remote/content/marionette):
 * - frames are `<ascii-decimal-length>:<utf8 json>`;
 * - the server's handshake is `{"applicationType":"gecko","marionetteProtocol":3}`;
 * - commands are `[0, msgId, "WebDriver:Name", params]`, responses `[1, msgId, error|null, body]`;
 * - the FIRST command must be `WebDriver:NewSession`.
 */

const MARIONETTE_PORT = 2828;

export class MarionetteError extends Error {
  constructor(
    message: string,
    readonly details: unknown,
  ) {
    super(message);
  }
}

export class MarionetteClient {
  private socket: Socket | null = null;
  private buffer: Buffer = Buffer.alloc(0);
  private pending: ((frame: MarionetteReply) => void) | null = null;
  private nextId = 0;

  /** Connects to an already-running Firefox's Marionette server, retrying until it is up. */
  async connect(retries = 60): Promise<void> {
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        this.socket = await new Promise<Socket>((resolve, reject) => {
          const socket = connect(MARIONETTE_PORT, '127.0.0.1', () => resolve(socket));
          socket.once('error', reject);
        });
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    if (this.socket === null) throw new Error(`Marionette never came up on port ${MARIONETTE_PORT}`);

    this.socket.on('data', (chunk) => this.onData(chunk));
    this.socket.on('error', (error) => this.failPending(error));
    this.socket.on('close', () => this.failPending(new Error('Marionette socket closed')));

    const handshake = (await this.readFrame(10_000)) as { marionetteProtocol?: number };
    if (handshake['marionetteProtocol'] !== 3) {
      throw new Error(`unexpected Marionette protocol: ${JSON.stringify(handshake)}`);
    }
  }

  private failPending(error: Error): void {
    this.pending?.(this.errorReply(error));
    this.pending = null;
  }

  private errorReply(error: Error): MarionetteReply {
    return [1, -1, { error: 'client-error', message: error.message, stacktrace: '' }, null];
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    this.tryParse();
  }

  /** Parses complete `<len>:<json>` frames; resolves the newest pending read. */
  private tryParse(): void {
    for (;;) {
      const colon = this.buffer.indexOf(0x3a);
      if (colon === -1) return;
      const length = Number(this.buffer.subarray(0, colon).toString('utf8'));
      if (!Number.isInteger(length) || length <= 0) return;
      if (this.buffer.length < colon + 1 + length) return;
      const payload = this.buffer.subarray(colon + 1, colon + 1 + length).toString('utf8');
      this.buffer = this.buffer.subarray(colon + 1 + length);
      this.pending?.(JSON.parse(payload));
      this.pending = null;
    }
  }

  private readFrame(timeoutMs: number): Promise<MarionetteReply> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Marionette frame timeout')), timeoutMs);
      this.pending = (frame) => {
        clearTimeout(timer);
        resolve(frame);
      };
    });
  }

  /** Sends one WebDriver command and resolves its result, throwing on a Marionette error reply. */
  async cmd<T = unknown>(name: string, params: Record<string, unknown> = {}, timeoutMs = 90_000): Promise<T> {
    if (this.socket === null) throw new Error('Marionette not connected');
    const id = ++this.nextId;
    const payload = Buffer.from(JSON.stringify([0, id, name, params]), 'utf8');
    this.socket.write(Buffer.concat([Buffer.from(`${payload.length}:`, 'utf8'), payload]));
    const frame = await this.readFrame(timeoutMs);
    if (!Array.isArray(frame) || frame.length !== 4) {
      throw new MarionetteError(`${name}: malformed reply frame`, frame);
    }
    const [replyType, replyId, error, body] = frame as [number, number, Record<string, string> | null, unknown];
    if (replyType !== 1) throw new MarionetteError(`${name}: unexpected reply type ${replyType}`, frame);
    if (error !== null) throw new MarionetteError(`${name} failed: ${error['message'] ?? JSON.stringify(error)}`, error);
    if (replyId !== id) throw new MarionetteError(`${name}: reply id mismatch (${replyId} ≠ ${id})`, null);
    return body as T;
  }

  /** Ends the session and closes the socket (the Firefox process itself is killed by the caller). */
  close(): void {
    try {
      this.socket?.end();
    } catch {
      // Socket already gone.
    }
    this.socket = null;
  }
}

type MarionetteReply = [number, number, Record<string, string> | null, unknown];

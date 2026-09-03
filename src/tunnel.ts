import * as net from "net";
import * as fs from "fs/promises";
import { Client as SshClient } from "ssh2";

export interface TunnelOptions {
  sshHost: string;
  sshPort: number;
  sshUser: string;
  privateKeyPath: string;
  passphrase?: string;
  /** MySQL host as seen FROM the SSH host. */
  destHost: string;
  /** MySQL port as seen FROM the SSH host. */
  destPort: number;
  /** Connection timeout in ms for the SSH handshake. */
  readyTimeout: number;
}

/**
 * An established SSH tunnel: an ssh2 client plus a local TCP listener on
 * 127.0.0.1. Each socket accepted by the listener is forwarded through the
 * SSH connection to the destination MySQL host/port. Point mysql2 at
 * {@link localPort}.
 */
export class SshTunnel {
  private constructor(
    private readonly client: SshClient,
    private readonly server: net.Server,
    /** The loopback port mysql2 should connect to. */
    readonly localPort: number,
  ) {}

  static async create(options: TunnelOptions): Promise<SshTunnel> {
    const privateKey = await fs.readFile(options.privateKeyPath);

    const client = new SshClient();

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => {
        client.removeListener("ready", onReady);
        reject(err);
      };
      const onReady = (): void => {
        client.removeListener("error", onError);
        resolve();
      };
      client.once("ready", onReady);
      client.once("error", onError);
      client.connect({
        host: options.sshHost,
        port: options.sshPort,
        username: options.sshUser,
        privateKey,
        passphrase: options.passphrase || undefined,
        readyTimeout: options.readyTimeout,
        // Do not keep prompting; fail fast so Test surfaces a clear error.
        tryKeyboard: false,
      });
    });

    const server = net.createServer((socket) => {
      client.forwardOut(
        "127.0.0.1",
        0,
        options.destHost,
        options.destPort,
        (err, stream) => {
          if (err) {
            socket.destroy(err);
            return;
          }
          socket.pipe(stream).pipe(socket);
          const cleanup = (): void => {
            stream.end();
            socket.destroy();
          };
          socket.on("error", cleanup);
          stream.on("error", cleanup);
        },
      );
    });

    const localPort = await new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      // Port 0 => OS assigns a free ephemeral port.
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (address && typeof address === "object") {
          resolve(address.port);
        } else {
          reject(new Error("Failed to bind local tunnel port"));
        }
      });
    });

    // If the SSH connection drops later, tear the listener down so pooled
    // sockets fail fast instead of hanging.
    client.on("close", () => server.close());

    return new SshTunnel(client, server, localPort);
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    this.client.end();
  }
}

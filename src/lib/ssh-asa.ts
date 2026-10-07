/**
 * SSH into Cisco ASA and run show crypto isakmp sa
 * Returns raw text output.
 */

import { Client } from "ssh2";
import { cfg } from "./config";

export interface AsaConnectResult {
  success: boolean;
  output: string;
  error?: string;
}

function execCommand(
  conn: Client,
  command: string
): Promise<string> {
  return new Promise((resolve, reject) => {
    conn.exec(command, (err, stream) => {
      if (err) return reject(err);
      let data = "";
      let errData = "";
      stream.on("data", (chunk: Buffer) => {
        data += chunk.toString();
      });
      stream.stderr.on("data", (chunk: Buffer) => {
        errData += chunk.toString();
      });
      stream.on("close", () => {
        resolve(data + errData);
      });
    });
  });
}

/**
 * Connect to ASA, run "show crypto isakmp sa", return output.
 * Falls back to enable mode if needed.
 */
export async function fetchAsaConnectivity(): Promise<AsaConnectResult> {
  return new Promise((resolve) => {
    const conn = new Client();

    const timeout = setTimeout(() => {
      conn.end();
      resolve({
        success: false,
        output: "",
        error: "SSH connection timed out after 30 seconds",
      });
    }, 30000);

    conn.on("ready", async () => {
      try {
        // For ASA we use a shell (exec doesn't work well on ASA IOS)
        const output = await runShellCommands(conn);
        clearTimeout(timeout);
        conn.end();
        resolve({ success: true, output });
      } catch (err: unknown) {
        clearTimeout(timeout);
        conn.end();
        resolve({
          success: false,
          output: "",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });

    conn.on("error", (err) => {
      clearTimeout(timeout);
      resolve({ success: false, output: "", error: err.message });
    });

    conn.connect({
      host: cfg.asa.host,
      port: cfg.asa.port,
      username: cfg.asa.user,
      password: cfg.asa.pass,
      readyTimeout: 25000,
      algorithms: {
        kex: [
          "diffie-hellman-group14-sha1",
          "diffie-hellman-group1-sha1",
          "diffie-hellman-group14-sha256",
          "ecdh-sha2-nistp256",
          "ecdh-sha2-nistp384",
          "ecdh-sha2-nistp521",
        ],
        cipher: [
          "aes128-cbc",
          "3des-cbc",
          "aes256-cbc",
          "aes128-ctr",
          "aes192-ctr",
          "aes256-ctr",
        ],
        serverHostKey: ["ssh-rsa", "ssh-dss"],
        hmac: ["hmac-sha1", "hmac-sha2-256"],
      },
    });
  });
}

function runShellCommands(conn: Client): Promise<string> {
  return new Promise((resolve, reject) => {
    conn.shell((err, stream) => {
      if (err) return reject(err);

      let output = "";
      let phase = 0;

      stream.on("data", (data: Buffer) => {
        output += data.toString();

        // Wait for prompt then send enable / command
        if (phase === 0 && (output.includes(">") || output.includes("#"))) {
          phase = 1;
          if (output.includes(">") && cfg.asa.enablePass) {
            stream.write("enable\n");
          } else {
            stream.write("terminal pager 0\n");
          }
        } else if (phase === 1 && output.includes("Password:")) {
          phase = 2;
          stream.write(`${cfg.asa.enablePass}\n`);
        } else if (
          (phase === 1 || phase === 2) &&
          output.includes("#")
        ) {
          phase = 3;
          stream.write("terminal pager 0\n");
        } else if (phase === 3 && output.includes("#")) {
          phase = 4;
          stream.write("show crypto isakmp sa\n");
        } else if (phase === 4 && output.includes("#")) {
          phase = 5;
          stream.write("exit\n");
        }
      });

      stream.on("close", () => {
        // Extract the relevant part of the output
        const lines = output.split("\n");
        const startIdx = lines.findIndex((l) =>
          l.includes("show crypto isakmp sa")
        );
        if (startIdx >= 0) {
          resolve(lines.slice(startIdx + 1).join("\n").trim());
        } else {
          resolve(output.trim());
        }
      });

      stream.on("error", reject);
    });
  });
}

/** Parse isakmp sa output into structured rows */
export interface IsakmpEntry {
  peerIp: string;
  state: string;
  connId: string;
  status: "UP" | "DOWN" | "UNKNOWN";
}

export function parseIsakmpOutput(raw: string): IsakmpEntry[] {
  const results: IsakmpEntry[] = [];
  const lines = raw.split(/\r?\n/);
  let ikev1Peer: string | undefined;
  let ikev2Status: string | undefined;

  for (const line of lines) {
    const ikev1PeerMatch = line.match(/IKE Peer:\s*(\d{1,3}(?:\.\d{1,3}){3})/);
    if (ikev1PeerMatch) {
      ikev1Peer = ikev1PeerMatch[1];
      continue;
    }

    const ikev1StateMatch = line.match(/\bState\s*:\s*(\S+)/);
    if (ikev1Peer && ikev1StateMatch) {
      const state = ikev1StateMatch[1];
      results.push({
        peerIp: ikev1Peer,
        state,
        connId: "",
        status:
          state === "MM_ACTIVE"
            ? "UP"
            : state.startsWith("MM_WAIT") || state === "MM_NO_STATE"
            ? "DOWN"
            : "UNKNOWN",
      });
      ikev1Peer = undefined;
      continue;
    }

    const ikev2StatusMatch = line.match(/Session-id:\s*(\d+),\s*Status:\s*([\w-]+)/);
    if (ikev2StatusMatch) {
      ikev2Status = ikev2StatusMatch[2];
      continue;
    }

    const ikev2TunnelMatch = line.match(
      /^\s*(\d+)\s+\d{1,3}(?:\.\d{1,3}){3}\/\d+\s+(\d{1,3}(?:\.\d{1,3}){3})\/\d+\s+(\S+)/
    );
    if (ikev2Status && ikev2TunnelMatch) {
      const state = ikev2Status;
      results.push({
        peerIp: ikev2TunnelMatch[2],
        state,
        connId: ikev2TunnelMatch[1],
        status:
          state === "UP-ACTIVE"
            ? "UP"
            : state.startsWith("DOWN")
            ? "DOWN"
            : "UNKNOWN",
      });
    }
  }
  return results;
}

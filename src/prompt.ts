import * as vscode from "vscode";
import { ConnectionConfig } from "./connections";

export interface PromptResult {
  config: Omit<ConnectionConfig, "id">;
  password: string;
}

async function ask(
  prompt: string,
  value: string,
  options: { password?: boolean; placeHolder?: string } = {},
): Promise<string | undefined> {
  return vscode.window.showInputBox({
    prompt,
    value,
    password: options.password,
    placeHolder: options.placeHolder,
    ignoreFocusOut: true,
  });
}

/**
 * Prompt for connection details. When `existing` is supplied the boxes are
 * pre-filled for editing; the password box is left blank and only overwrites
 * the stored secret if the user types something.
 */
export async function promptConnection(
  existing?: ConnectionConfig,
): Promise<PromptResult | undefined> {
  const name = await ask("Connection name", existing?.name ?? "", {
    placeHolder: "e.g. Local MySQL",
  });
  if (name === undefined || name.trim() === "") {
    return undefined;
  }

  const host = await ask("Host", existing?.host ?? "127.0.0.1");
  if (host === undefined) {
    return undefined;
  }

  const portRaw = await ask("Port", String(existing?.port ?? 3306));
  if (portRaw === undefined) {
    return undefined;
  }
  const port = Number.parseInt(portRaw, 10);
  if (Number.isNaN(port) || port <= 0 || port > 65535) {
    void vscode.window.showErrorMessage("Port must be a number 1–65535.");
    return undefined;
  }

  const user = await ask("User", existing?.user ?? "root");
  if (user === undefined) {
    return undefined;
  }

  const password = await ask(
    existing
      ? "Password (leave blank to keep the stored password)"
      : "Password",
    "",
    { password: true },
  );
  if (password === undefined) {
    return undefined;
  }

  const defaultSchema = await ask(
    "Default schema (OPTIONAL — leave blank to browse ALL schemas)",
    existing?.defaultSchema ?? "",
    { placeHolder: "leave blank for the whole server" },
  );
  if (defaultSchema === undefined) {
    return undefined;
  }

  return {
    config: {
      name: name.trim(),
      host: host.trim() || "127.0.0.1",
      port,
      user: user.trim(),
      defaultSchema: defaultSchema.trim() || undefined,
    },
    password,
  };
}

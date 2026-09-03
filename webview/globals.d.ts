// Ambient declarations for the webview runtime globals.

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

interface Window {
  MONACO_WORKER_URI: string;
}

declare var MONACO_WORKER_URI: string;

// Side-effect CSS imports (esbuild bundles them via the css loader).
declare module "*.css";

import type { HostToWebviewMessage, WebviewToHostMessage } from '../shared/protocol';

interface VsCodeApi {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

export const vscode: VsCodeApi = acquireVsCodeApi();

export function post(msg: WebviewToHostMessage): void {
  vscode.postMessage(msg);
}

type Handler = (msg: HostToWebviewMessage) => void;
const handlers = new Set<Handler>();

window.addEventListener('message', (event) => {
  const data = event.data as HostToWebviewMessage | undefined;
  if (!data || typeof (data as any).type !== 'string') return;
  for (const h of handlers) h(data);
});

export function onHostMessage(handler: Handler): () => void {
  handlers.add(handler);
  return () => handlers.delete(handler);
}

export function createRequestId(): string {
  return `req-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

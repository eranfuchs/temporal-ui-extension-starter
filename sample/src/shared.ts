// Connection details, in one place so the worker and the client cannot disagree
// about which task queue they are using — a mismatch there looks exactly like a
// dead worker: the workflow starts, and then nothing ever happens.
//
// Defaults point at a local `temporal server start-dev` and nowhere else.

export const ADDRESS = process.env.TEMPORAL_ADDRESS ?? '127.0.0.1:7233';
export const NAMESPACE = process.env.TEMPORAL_NAMESPACE ?? 'default';
export const TASK_QUEUE = process.env.TEMPORAL_TASK_QUEUE ?? 'ui-extension-starter';
// Where the dev server's own web UI lives, for the "now go and look" line.
export const UI_BASE_URL = process.env.TEMPORAL_UI_URL ?? 'http://localhost:8233';

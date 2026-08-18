// api.js — toda a conversa com o servidor local, tipada e com erro tratado.

async function jget(path) {
  const r = await fetch(path);
  const d = await r.json();
  if (!r.ok) throw new ApiError(d.error || `HTTP ${r.status}`, r.status, d);
  return d;
}
async function jpost(path, body) {
  const r = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError(d.error || `HTTP ${r.status}`, r.status, d);
  return d;
}

export class ApiError extends Error {
  constructor(msg, status, data) { super(msg); this.status = status; this.data = data; }
}

export const api = {
  session:  () => jget("/api/session"),
  lists:    () => jget("/api/lists"),
  browsers: () => jget("/api/browsers"),
  jobs:     () => jget("/api/jobs"),
  authManual: (cookie, username) =>
    jpost("/api/auth", { cookie, username, source: "colado à mão" }),
  importFrom: (browser, profile, username) => jpost("/api/import", { browser, profile, username }),
  logout:   () => jpost("/api/logout"),
  reset:    () => jpost("/api/reset"),
  quit:     () => jpost("/api/quit"),
  cancel:   (job) => jpost("/api/cancel", { job }),
  collect:  (opts) => jpost("/api/collect", opts),
  exportUrl: (name, fmt) => `/api/export?name=${name}&format=${fmt}`,
};

// Escuta o SSE de um job. Callbacks: onProgress, onWarn, onPassDone, onDone, onError, onLost.
export function stream(jobId, cb) {
  const es = new EventSource(`/api/stream?job=${jobId}`);
  let finished = false, lostTimer = null;
  const clearLost = () => { if (lostTimer) { clearTimeout(lostTimer); lostTimer = null; } };
  es.onopen = clearLost;                 // reconectou → não está perdido
  es.onmessage = (m) => {
    clearLost();
    const d = JSON.parse(m.data);
    if (d.event === "progress") cb.onProgress?.(d);
    else if (d.event === "warn") cb.onWarn?.(d);
    else if (d.event === "pass_done") cb.onPassDone?.(d);
    else if (d.event === "error") { finished = true; es.close(); cb.onError?.(d); }
    else if (d.event === "done") { finished = true; es.close(); cb.onDone?.(d); }
  };
  es.onerror = () => {
    if (finished) return;
    // Servidor caiu (janela preta fechada): o EventSource fica em CONNECTING
    // tentando reconectar para sempre — nunca chega a CLOSED. Detectamos pela
    // transição para não-OPEN e damos um tempo de graça para uma reconexão
    // real (o próprio browser reabre em ~3s). Uma pausa de rate-limit mantém
    // o socket OPEN, então não dispara aqui.
    if (es.readyState === EventSource.CLOSED) { es.close(); cb.onLost?.(); return; }
    if (es.readyState === EventSource.CONNECTING && !lostTimer) {
      lostTimer = setTimeout(() => {
        if (!finished && es.readyState !== EventSource.OPEN) { es.close(); cb.onLost?.(); }
      }, 8000);
    }
  };
  return { close: () => { finished = true; clearLost(); es.close(); } };
}

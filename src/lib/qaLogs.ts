/**
 * Guardado automático de Q&A en GitHub (carpeta qa-logs/).
 *
 * Requisito: correr en segundo plano, SIN preguntar al usuario final
 * dónde guardar ni gestionar nada. Solo crea el .txt en GitHub.
 *
 * Cómo funciona:
 *  - Tras cada respuesta exitosa de Gemini, App.tsx dispara
 *    `void saveQALogBackground(...)` (fire-and-forget, no bloquea la UI).
 *  - Si el token/repo no están configurados, no hace nada (silencioso).
 *  - Usa la GitHub Contents API: PUT /repos/{owner}/{repo}/contents/qa-logs/{file}
 *
 * El token sale del build (Secrets → Actions → VITE_GITHUB_TOKEN).
 * El docente no pega nada en la app: el guardado es totalmente automático.
 *  - VITE_GITHUB_REPO:     "owner/repo" (default: "cuentoslcortos-stack/91")
 *  - VITE_QA_LOGS_DIR:     carpeta destino (default: "qa-logs")
 *  - VITE_QA_LOG_PREFIX:   prefijo del archivo (default: "asis-91")
 *  - VITE_QA_LOGS_BRANCH:  rama destino (default: "main")
 *
 * IMPORTANTE: las vars VITE_* quedan visibles en el JS compilado.
 * El PAT debe estar limitado a este repo y solo a Contents R/W.
 */

export interface QALogPayload {
  /** Respuesta ya sanitizada que se mostró en pantalla. */
  answer: string;
  /** Transcripción de la pregunta (si se dispone; hoy la pregunta es audio). */
  questionTranscript?: string;
  /** Modelo usado (para auditoría en el txt). */
  model?: string;
  /** Metadata del clip de audio (la "pregunta" es oral). */
  audioBytes?: number;
  audioMime?: string;
  durationMs?: number;
}

function env(key: string): string {
  try {
    return (
      (import.meta as ImportMeta & { env: Record<string, string | undefined> }).env?.[key] ?? ""
    ).trim();
  } catch {
    return "";
  }
}

/**
 * Token de GitHub para el guardado automático de Q&A.
 *
 * Resolución (en orden de prioridad):
 *   1. localStorage "gem-github-token" — lo que el usuario pegó en el
 *      panel de Configuración de la app (clave preferida, NUNCA queda
 *      en el bundle JS público porque localStorage es por origen).
 *   2. VITE_GITHUB_TOKEN — variable de entorno legacy. ⚠️ Esta SÍ se
 *      compila en el JS público, así que solo es aceptable en builds
 *      locales que no se deployan. Recomendamos no usarla: poné el
 *      token en el panel de Configuración.
 *
 * Si ninguno está, el guardado automático queda desactivado en
 * silencio (la app sigue funcionando normal).
 */
function readGithubToken(): string {
  try {
    const fromLs = (typeof localStorage !== "undefined"
      ? localStorage.getItem("gem-github-token")
      : null)?.trim();
    if (fromLs) return fromLs;
  } catch {
    /* sin localStorage: cae al env */
  }
  return env("VITE_GITHUB_TOKEN");
}

export function isQALogEnabled(): boolean {
  const token = readGithubToken();
  const repo = env("VITE_GITHUB_REPO") || "cuentoslcortos-stack/91";
  if (!token || !repo.includes("/")) return false;
  if (env("VITE_QA_LOGS_ENABLED") === "0") return false;
  return true;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Prefijo-Fecha: asis-91-2026-09-06-20-25-39.txt */
export function buildQALogFilename(now = new Date()): string {
  const prefix = env("VITE_QA_LOG_PREFIX") || "asis-91";
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  return `${prefix}-${stamp}.txt`;
}

function toBase64Utf8(text: string): string {
  // btoa directo rompe con tildes/UTF-8; este wrap es el estándar.
  return btoa(unescape(encodeURIComponent(text)));
}

function formatDurationShort(ms?: number): string | null {
  if (typeof ms !== "number" || !isFinite(ms) || ms < 0) return null;
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * Formato del txt (idéntico al histórico de qa-logs):
 *
 *   asis-91 · 6/9/2026, 20:25:39 · 0:42
 *   ============================================================
 *   PREGUNTA:
 *   <transcripción literal>
 *
 *   RESPUESTA:
 *   <respuesta>
 *   ============================================================
 *
 * Sin metadata ni campos extra: solo pregunta y respuesta.
 */
function buildQALogBody(p: QALogPayload, now = new Date()): string {
  const prefix = env("VITE_QA_LOG_PREFIX") || "asis-91";
  const dateStr = now.toLocaleString("es-AR");
  const tail =
    formatDurationShort(p.durationMs) ??
    `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const sep = "=".repeat(60);
  const lines: string[] = [];
  lines.push(`${prefix} · ${dateStr} · ${tail}`);
  lines.push(sep);
  lines.push("");
  lines.push("PREGUNTA:");
  if (p.questionTranscript && p.questionTranscript.trim()) {
    lines.push(p.questionTranscript.trim());
  } else {
    lines.push("(pregunta formulada por voz; transcripcion no disponible)");
  }
  lines.push("");
  lines.push("RESPUESTA:");
  lines.push((p.answer ?? "").trim());
  lines.push("");
  lines.push(sep);
  return lines.join("\n");
}

/**
 * Guarda el log en GitHub en segundo plano. NUNCA lanza excepción ni
 * muestra UI: ante cualquier fallo solo hace console.debug y retorna.
 * No usa <input type="file"> ni showSaveFilePicker: cero interacción.
 */
export async function saveQALogBackground(payload: QALogPayload): Promise<void> {
  try {
    if (!payload?.answer?.trim()) return;
    const token = readGithubToken();
    const repo = env("VITE_GITHUB_REPO") || "cuentoslcortos-stack/91";
    if (!token || !repo.includes("/")) return; // no configurado → silencioso

    const dir = (env("VITE_QA_LOGS_DIR") || "qa-logs").replace(/^\/+|\/+$/g, "");
    const branch = env("VITE_QA_LOGS_BRANCH") || "main";
    const now = new Date();
    const filename = buildQALogFilename(now);
    const path = `${dir}/${filename}`;
    const body = buildQALogBody(payload, now);

    const res = await fetch(
      `https://api.github.com/repos/${repo}/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}`,
      {
        method: "PUT",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message: `qa: ${filename}`,
          content: toBase64Utf8(body),
          branch,
        }),
      }
    );
    if (!res.ok) {
      // 401/403 típico = token ausente o sin permiso Contents R/W.
      // Silencioso por diseño (no molestar al alumno en mesa de estudio).
      if (typeof console !== "undefined") {
        console.debug(`[qa-logs] GitHub API ${res.status} al guardar ${filename}`);
      }
    }
  } catch (err) {
    if (typeof console !== "undefined") {
      console.debug(`[qa-logs] fallo silencioso: ${(err as Error)?.message ?? err}`);
    }
  }
}

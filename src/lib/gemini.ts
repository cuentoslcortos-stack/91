import { GoogleGenAI, ThinkingLevel } from "@google/genai";

export const GEMINI_MODEL = "gemini-3.6-flash";

/**
 * Identifica a la materia y sirve como anclaje en la UI
 * (panel de Configuración muestra este string).
 */
export const ASSISTANT_LABEL =
  "Asistente 91 — Neuropsicología (Cód. 91, Cátedra Politis — Dr. Daniel Gustavo Politis, UBA Psicología)";

/**
 * Base de conocimiento de la materia: PDFs servidos como archivos
 * estáticos en `public/` y subidos a Gemini File API en runtime.
 *
 * El modelo NO debe responder con nada que no esté en estos dos PDFs.
 * Se suben a Gemini File API una sola vez por sesión y se referencian
 * por fileUri (cache 24 h en localStorage).
 */
const VITE_BASE_URL: string =
  ((import.meta as ImportMeta & { env: Record<string, string | undefined> }).env?.BASE_URL ?? "/");

const PDF_SOURCES: ReadonlyArray<{ name: string; path: string }> = [
  { name: "01.NPS_1P.pdf", path: `${VITE_BASE_URL}01.NPS_1P.pdf` },
  { name: "02.NPS_2P.pdf", path: `${VITE_BASE_URL}02.NPS_2P.pdf` },
] as const;

/**
 * Cache en localStorage: para cada PDF guardamos { uri, expiry }.
 * TTL: 24h (la File API de Gemini expira a las 48h, dejamos margen).
 */
const KB_CACHE_PREFIX = "gem-pdf-uri:";
const KB_TTL_MS = 24 * 60 * 60 * 1000;

interface CachedUri {
  uri: string;
  expiry: number;
}

function readCachedUri(name: string): string | null {
  try {
    const raw = localStorage.getItem(KB_CACHE_PREFIX + name);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedUri;
    if (!parsed?.uri || !parsed?.expiry) return null;
    if (parsed.expiry < Date.now()) return null;
    return parsed.uri;
  } catch {
    return null;
  }
}

function writeCachedUri(name: string, uri: string): void {
  try {
    const payload: CachedUri = { uri, expiry: Date.now() + KB_TTL_MS };
    localStorage.setItem(KB_CACHE_PREFIX + name, JSON.stringify(payload));
  } catch {
    /* sin persistencia: se re-subirá cada vez */
  }
}

/**
 * Sube un PDF a Gemini File API y devuelve el fileUri.
 * Si ya hay uno cacheado en localStorage (no expirado), lo reusa.
 */
async function ensurePdfUploaded(
  ai: GoogleGenAI,
  name: string,
  path: string
): Promise<string> {
  const cached = readCachedUri(name);
  if (cached) return cached;

  const res = await fetch(path);
  if (!res.ok) {
    throw new Error(`No se pudo cargar ${name} desde el sitio (HTTP ${res.status}).`);
  }
  const blob = await res.blob();
  if (blob.size === 0) {
    throw new Error(`El archivo ${name} está vacío.`);
  }

  const uploaded = await ai.files.upload({
    file: new File([blob], name, { type: "application/pdf" }),
    config: { displayName: name },
  });
  const uri = uploaded?.uri;
  if (!uri) {
    throw new Error(`No se pudo subir ${name} a Gemini File API.`);
  }
  writeCachedUri(name, uri);
  return uri;
}

/**
 * Prepara la base de conocimiento: sube los PDFs declarados en
 * `PDF_SOURCES` a Gemini File API (o reutiliza los URIs cacheados)
 * y devuelve un array de `fileData` listo para meter en `parts[]`.
 *
 * Si `PDF_SOURCES` está vacío, lanza un error claro para que el
 * usuario sepa que falta cargar el material antes de usar la app.
 */
async function buildKnowledgeBaseParts(
  ai: GoogleGenAI,
  onProgress?: (msg: string) => void
): Promise<{ fileData: { fileUri: string; mimeType: string } }[]> {
  if (PDF_SOURCES.length === 0) {
    throw new Error(
      "La base de conocimiento está vacía. Copiá los PDFs a public/ y " +
        "registralos en PDF_SOURCES dentro de src/lib/gemini.ts."
    );
  }
  const parts: { fileData: { fileUri: string; mimeType: string } }[] = [];
  for (const src of PDF_SOURCES) {
    onProgress?.(`Subiendo ${src.name} a Gemini…`);
    const uri = await ensurePdfUploaded(ai, src.name, src.path);
    parts.push({ fileData: { fileUri: uri, mimeType: "application/pdf" } });
  }
  return parts;
}

/**
 * Prompt del sistema — Tutor 91, materia "Neuropsicología"
 * (Cátedra Prof. Dr. Daniel Gustavo Politis, Psicología, UBA, Código 91).
 *
 * Fuente única del prompt (NO se carga de public/SystemPrompt.txt en
 * runtime: ese archivo es solo documentación).
 */
export const SYSTEM_PROMPT = `# SYSTEM PROMPT: TUTOR IA DE NEUROPSICOLOGÍA (CÁTEDRA POLITIS)

Rol: Tutor IA experto y Jefe de Trabajos Prácticos en Neuropsicología (Cátedra Prof. Dr. Daniel Gustavo Politis, Psicología UBA, Código 91).
Objetivo: Resolver con absoluta precisión técnica evaluaciones de examen en tres modalidades: (1) Preguntas de opción múltiple (Multiple Choice de 4 o 5 opciones), (2) Preguntas de Verdadero o Falso con justificación, y (3) Ejercicios de completar frases/oraciones con los términos técnicos exactos (Cloze). El modelo clarifica arquitectura cognitiva, semiología, modelos teóricos e instrumentos de evaluación y rehabilitación bajo el estricto marco de la cátedra, utilizando ÚNICA Y EXCLUSIVAMENTE los documentos provistos: "01.NPS_1P.pdf" (Unidades 1 a 5) y "02.NPS_2P.pdf" (Unidades 6 a 10).

CONTEXTO DE EVALUACIÓN Y TEMARIO - Exámenes presenciales con viñetas clínicas, disociaciones (simples y dobles), diagnóstico diferencial, tipos de errores gnósicos/práxicos y pruebas neuropsicológicas específicas.

---

### 1. IDENTIDAD Y ROL
Eres un Tutor Experto y Jefe de Trabajos Prácticos de la materia "Neuropsicología" (Código 91, Cátedra Prof. Dr. Daniel Gustavo Politis) para la carrera de Licenciatura en Psicología de la Universidad de Buenos Aires (UBA). Tu rol es resolver con absoluta precisión técnica evaluaciones de examen en tres modalidades:
1. Preguntas de opción múltiple (Multiple Choice de 4 o 5 opciones).
2. Preguntas de Verdadero o Falso con justificación.
3. Ejercicios de completar frases/oraciones con los términos técnicos exactos (Cloze).
Asimismo, clarificas la arquitectura cognitiva, semiología, modelos teóricos e instrumentos de evaluación y rehabilitación bajo el estricto marco de la cátedra.

### 2. CONTEXTO Y BASE DE DATOS
El estudiante se prepara para rendir exámenes presenciales. Tus fuentes exclusivas de conocimiento provienen de los documentos y programas oficiales de la cátedra:
- 01.NPS_1P.pdf: Contenidos de las Unidades 1 a 5 (Introducción, Agnosias, Apraxias, Memoria y Amnesia, Rehabilitación).
- 02.NPS_2P.pdf: Contenidos de las Unidades 6 a 10 (Conocimiento Semántico, Síndrome Disejecutivo, Cognición Social/ToM, TEA, Demencias).
Las evaluaciones aplican viñetas clínicas, disociaciones (simples y dobles), diagnóstico diferencial, tipos de errores gnósicos/práxicos y pruebas neuropsicológicas específicas.

### 3. CORAZÓN CENTRAL Y NÚCLEO TEÓRICO DE LA CÁTEDRA POLITIS
Toda resolución debe articularse conceptualmente desde el marco de la Neuropsicología Cognitiva:
- Enfoque Cognitivo y Modularidad: Mente como sistema de procesamiento compuesto por módulos independientes. Método de caso único, análisis de errores y disociaciones para inferir arquitectura mental normal.
- Dicotomía Procesamiento Ventral vs. Dorsal:
  - Vía Ventral ("Qué"): Procesamiento visual para reconocimiento de objetos y rostros (Agnosias visuales: aperceptiva vs. asociativa).
  - Vía Dorsal ("Cómo/Dónde"): Procesamiento visuoespacial y guión de la acción motora voluntaria (Apraxias y trastornos atencionales/espaciales).
- Modelos Cognitivos Específicos:
  - Gnosias: Modelos de Lissauer, Marr, Ellis y Young.
  - Praxias: Modelo clásico de Liepmann, modelo cognitivo de Rothi, Ochipa y Heilman, modelo de Buxbaum.
  - Memoria: Memoria de trabajo (Baddeley) y sistemas declarativo/no declarativo (Squire).
  - Semántica: Organización, acceso semántico y hubs semánticos.
  - Funciones Ejecutivas y Cognición Social: Control inhibitorio, planificación, ToM (primer y segundo orden), procesamiento emocional (corteza prefrontal dorsolateral, orbitofrontal y ventromedial).

### 4. EJES TEMÁTICOS Y AUTORES CLAVE
- Introducción: Modularidad, disociaciones (Escera, Drake, Ellis & Young).
- Agnosias: Vía Ventral, aperceptiva/asociativa, prosopagnosia, negligencia (Lissauer, Marr, Chávez, Tabernero & Politis).
- Apraxias: Vía Dorsal, ideomotora, ideatoria, errores práxicos (Liepmann, Rothi et al., Buxbaum, Politis & Rubinstein).
- Memoria: Declarativa/no declarativa, amnesia retrógrada/anterógrada, Ribot (Tirapu Ustárroz & Grandi, Pinel, Harris, Fontán).
- Rehabilitación: Restauración, compensación, sustitución, prótesis (Muñoz Céspedes, Fernández-Guinea, Mateer).
- Semántica: Memoria y acceso semántico, demencia semántica vs afasia óptica (Peraita, Patterson, Martínez-Cuitiño).
- Disejecutivo: Circuitos frontosubcorticales, control e inhibición (Gómez Beldarrain, Pineda, Verdejo-García & Bechara).
- Cognición Social / ToM: Falsa creencia, faux pas, empatía, variantes frontales (Tirapu-Ustárroz, Moyano).
- TEA: Criterios DSM-5, coherencia central, ToM, tests IDEA, ADOS, ADI-R (Grañana, Rivière).
- Demencias/DCL: DCL, Alzheimer, Vascular, FTD, Lewy, screening (Arizaga, Allegri, Genovese, Mangone).

### 5. REGLAS Y RESTRICCIONES (STRICT MODE)
- REGLA 1 (Aislamiento de Conocimiento): Responde EXCLUSIVAMENTE según el programa de la Cátedra Politis. No utilices clasificaciones externas no contempladas en su bibliografía.
- REGLA 2 (Límites del Programa): Si la consulta es ajena al programa (p. ej., neuroanatomía quirúrgica no funcional, psicofarmacología detallada), rechaza respondiendo textualmente: "Como tutor, me ciño estrictamente al programa de Neuropsicología de la Cátedra Politis. Ese tema excede los contenidos evaluados en la materia."
- REGLA 3 (Generación de Práctica): Sólo genera simulacros si el usuario lo pide explícitamente ("Deseo un simulacro" o "Genera preguntas"). En ese caso, presenta bloques de 3 a 5 preguntas con viñetas clínicas breves.
- REGLA 4 (Invisibilidad de la Estructura): NUNCA menciones números de unidad (ej. "En la Unidad 3...") en tus respuestas.
- REGLA 5 (Cero Cortesía): Sin saludos ("Hola"), sin introducciones ni despedidas. Ve directo a la resolución técnica.
- REGLA 6 (Concisión Absoluta): No te extiendas en rodeos. Ajústate con exactitud a los formatos estructurados de respuesta.
- REGLA 7 (Sin Preguntas al Final): Prohibido cerrar con "¿Quieres más ejercicios?", "¿Te queda claro?" o similares.

### 6. FORMATOS OBLIGATORIOS DE RESPUESTA
Dependiendo del tipo de ejercicio provisto por el usuario, aplica únicamente el bloque correspondiente:

CASO A: Si el ejercicio es Multiple Choice:
1. Opción correcta: [Letra/número y texto exacto de la opción]
2. Por qué las otras son incorrectas: [Una sola oración global explicando por qué se descartan los distractores teóricos].

CASO B: Si el ejercicio es Verdadero / Falso:
1. Calificación: [Verdadero o Falso]
2. Justificación: [Máximo dos oraciones fundamentando teóricamente según el modelo o autor de la cátedra].

CASO C: Si el ejercicio es Completar Frases / Textos:
1. Palabra(s) / Concepto(s) faltante(s): [Término o términos técnicos exactos en el orden correspondiente]
2. Frase completa: [La oración reconstituida de forma íntegra]
3. Fundamento: [Una sola oración justificando el término desde el modelo teórico de la cátedra].`;

/**
 * Nota legible sobre qué hay cargado como base de conocimiento.
 * Sólo se usa en logs / debug; el modelo la ignora.
 */
export const KNOWLEDGE_BASE_NOTE =
  "Base de conocimiento: 01.NPS_1P.pdf (1P — Introducción, Agnosias, Apraxias, Memoria y Amnesia, Rehabilitación) + 02.NPS_2P.pdf (2P — Conocimiento Semántico, Síndrome Disejecutivo, Cognición Social/ToM, TEA, Demencias) — subidos a Gemini File API.";

/**
 * Esta constante quedó vacía por seguridad: la API key SOLO vive en el
 * navegador del usuario (campo "API Key de Gemini" en el panel de
 * Configuración, persistida en localStorage). NO la leemos de variables
 * de entorno porque las `VITE_*` se compilan dentro del bundle JS público
 * y quedan expuestas en GitHub Pages.
 *
 * El nombre del export se mantiene para no romper App.tsx ni a ningún
 * importador externo; su valor siempre es "" en build, y la app usa la
 * key que venga como argumento (`apiKey` en cada llamada).
 */
export const GEMINI_API_KEY: string = "";


export function pickMimeType(): string {
  if (typeof MediaRecorder === "undefined") return "audio/webm";
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/ogg;codecs=opus",
  ];
  return candidates.find((m) => MediaRecorder.isTypeSupported(m)) ?? "audio/webm";
}

/**
 * Convierte un Blob (audio grabado) a una cadena Base64 *sin* el prefijo
 * `data:<mime>;base64,` que agrega FileReader — es lo que espera Gemini
 * en `inlineData.data`.
 */
export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? "");
      resolve(result.split(",")[1] ?? "");
    };
    reader.onerror = () => reject(new Error("No se pudo codificar el audio a Base64."));
    reader.readAsDataURL(blob);
  });
}

/**
 * Limpia el texto que devuelve Gemini antes de mostrarlo o leerlo en voz
 * alta. Caza los artefactos típicos de cuando el modelo se "contagia" del
 * formato de transcripción de audio (timecodes SRT/VTT, etiquetas de
 * hablante, etc.) y de cualquier residuo de markdown que el TTS leería
 * literal (asteriscos, guiones bajos, etc.). Pensada como red de seguridad:
 * aunque el system prompt lo prohíba, el modelo a veces los emite igual.
 *
 * Patrones que elimina:
 *  - Sello MM:SS o HH:MM:SS pegado o suelto:           00:05 · 1:23 · 00:05.123
 *  - Pegado a una palabra (sin espacio):                "socio01:03estructural" → "socioestructural"
 *  - Con corchetes / ángulos / paréntesis:              [00:05] · <00:05> · (00:05)
 *  - Rangos SRT/VTT:                                    00:05 --> 00:08 · 00:05,000 --> 00:08,000
 *  - Etiquetas de hablante:                             Speaker 1: · Hablante 2:
 *  - Líneas que son solo un número (índices SRT)
 *  - Marcado Markdown simple: **negrita**, *itálica*, _itálica_, `código`
 */
export function sanitizeResponseText(text: string): string {
  if (!text) return text;
  let t = text;
  // 1) Índices de bloque SRT: una línea entera que es solo 1-4 dígitos
  t = t.replace(/^\s*\d{1,4}\s*$/gm, "");
  // 2) Rangos SRT/VTT: "00:05 --> 00:08" / "00:05,000 --> 00:08,000"
  t = t.replace(
    /\b\d{1,2}:\d{2}(?:[.,]\d{1,3})?\s*-->\s*\d{1,2}:\d{2}(?:[.,]\d{1,3})?\b/g,
    " "
  );
  // 3) Sellos de tiempo con corchetes/ángulos/paréntesis: [00:05], <1:23>
  t = t.replace(
    /[\[\<\(]\s*\b\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?\b\s*[\]\>\)]/g,
    " "
  );
  // 4) Sellos sueltos: 00:05, 1:23, 00:05.123 (incluye HH:MM:SS).
  //    Importante: NO usar \b al final, porque un sello pegado a una
  //    palabra ("socio01:03estructural") no tiene word boundary y el
  //    \b lo dejaría pasar. Usamos (?<!\d) al inicio (para no
  //    comernos el "12" de "12:00:30") y (?!\d) al final (para no
  //    comernos el "00" de "12:00:30.5"). El reemplazo es "" (sin
  //    espacio) para que el texto fluya al pegarse a la palabra.
  t = t.replace(/(?<!\d)\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?(?!\d)/g, "");
  // 5) Etiquetas de hablante: "Speaker 1:", "Hablante 2]", "Speaker1 -"
  t = t.replace(/\b(?:Speaker|Hablante|Unknown)\s*\d+\s*[:\-\]]\s*/gi, " ");
  // 6) Markdown residual: negrita (**), itálica (*) y código (`).
  //    El system prompt prohíbe markdown, pero a veces el modelo se
  //    "contagia" y lo emite igual — y speechSynthesis lo lee literal
  //    ("asterisco asterisco negrita asterisco asterisco").
  t = t.replace(/\*\*([^*]+)\*\*/g, "$1");
  t = t.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1$2");
  t = t.replace(/`([^`]+)`/g, "$1");
  // 6.5) Guiones largos / rayas (—, –) y secuencias de guiones
  //      enfáticos. El system prompt los prohíbe, pero el modelo
  //      a veces los emite como pausas dramáticas. speechSynthesis
  //      los lee literal ("guión guión guión..."). Los borramos como
  //      red de seguridad antes de la limpieza final.
  t = t.replace(/[—–]+/g, " ");
  // 7) Limpieza: colapsa espacios y saltos de línea sobrantes
  t = t.replace(/[ \t]{2,}/g, " ");
  t = t.replace(/[ \t]+\n/g, "\n");
  t = t.replace(/\n{3,}/g, "\n\n");
  return t.trim();
}

/** Extrae un mensaje legible de un error arbitrario (incluido el del SDK). */
function describeError(err: unknown): string {
  if (typeof err === "string") return err;
  if (err && typeof err === "object") {
    const e = err as {
      message?: string;
      status?: number | string;
      code?: number | string;
      error?: { message?: string; code?: number | string; status?: string };
    };
    if (e.error?.message) {
      const code = e.error.code ?? e.error.status ?? e.status ?? e.code;
      return code ? `[${code}] ${e.error.message}` : e.error.message;
    }
    if (e.message) return e.message;
  }
  return "Error desconocido al hablar con Gemini.";
}

/**
 * Detecta errores transitorios del servicio (503 UNAVAILABLE,
 * "high demand", "overloaded", etc.). En esos casos, reintentamos
 * una vez antes de mostrar el error al usuario.
 */
function isTransientError(err: unknown): boolean {
  const detail = describeError(err).toLowerCase();
  return (
    detail.includes("503") ||
    detail.includes("unavailable") ||
    detail.includes("high demand") ||
    detail.includes("overloaded") ||
    detail.includes("try again later")
  );
}

/**
 * Sube los PDFs de la bibliografía a Gemini File API (o reutiliza
 * los URIs cacheados en localStorage). Es idempotente: si el cache
 * expiró o nunca existió, sube; si todavía es válido, no hace nada.
 *
 * Útil para "calentar" la base de conocimiento al inicio de la sesión
 * y para que la UI pueda mostrar el estado ("Subiendo PDFs a Gemini…").
 */
export async function warmupKnowledgeBase(
  apiKey: string,
  onProgress?: (msg: string) => void
): Promise<void> {
  const cleanKey = apiKey.trim();
  if (!cleanKey || cleanKey === "TU_API_KEY_AQUI") {
    throw new Error("Configura tu API Key de Gemini en el panel de Configuración.");
  }
  const ai = new GoogleGenAI({ apiKey: cleanKey });
  await buildKnowledgeBaseParts(ai, onProgress);
}

/**
 * Indica si la base de conocimiento ya está cacheada y vigente.
 * Devuelve true si AMBOS PDFs tienen un fileUri no expirado.
 */
export function isKnowledgeBaseReady(): boolean {
  return PDF_SOURCES.every((s) => readCachedUri(s.name) !== null);
}

/**
 * Envía el audio + la base de conocimiento (PDFs vía File API) a Gemini
 * usando el SDK oficial `@google/genai`.
 *
 * Estructura del request:
 *   parts: [
 *     ...pdfFileData[],              // todos los PDFs en PDF_SOURCES
 *     { inlineData: <audio> },       // clip grabado
 *     { text: <instrucción> }        // "Escuchá el audio y respondé…"
 *   ]
 *
 * Manejo de errores:
 *  - Errores transitorios (503/UNAVAILABLE/"high demand"): reintenta una
 *    vez con 4 s de espera. Si el segundo intento también falla, muestra
 *    un mensaje claro en español.
 *  - API key inválida / 401/403: mensaje específico, sin reintento.
 *  - Cuota agotada / 429: mensaje específico, sin reintento.
 *  - Errores de red: mensaje específico, sin reintento.
 */
export async function askGemini(
  base64Audio: string,
  mimeType: string,
  apiKey: string,
  onProgress?: (msg: string) => void
): Promise<string> {
  const cleanKey = apiKey.trim();
  if (!cleanKey || cleanKey === "TU_API_KEY_AQUI") {
    throw new Error("Configura tu API Key de Gemini en el panel de Configuración.");
  }

  const ai = new GoogleGenAI({ apiKey: cleanKey });

  // 1) Base de conocimiento: sube los PDFs a File API (o reusa cache).
  onProgress?.("Preparando base de conocimiento…");
  const pdfParts = await buildKnowledgeBaseParts(ai, onProgress);

  const contents = [
    {
      parts: [
        ...pdfParts,
        { inlineData: { mimeType, data: base64Audio } },
        {
          text:
            "Escuchá el audio adjunto y respondé según las instrucciones del sistema. " +
            "Tu respuesta debe fundamentarse exclusivamente en los PDFs cargados " +
            "como base de conocimiento (ver PDF_SOURCES en src/lib/gemini.ts). " +
            "Ajustate al formato y la extensión definidos en el system prompt.",
        },
      ],
    },
  ];
  const config = {
    systemInstruction: SYSTEM_PROMPT,
    // 4096 tokens: en Gemini 3, los tokens de thinking cuentan contra
    // maxOutputTokens. Con este margen, el modelo tiene aire para
    // pensar (poco) y responder las 200-250 palabras que exige el
    // system prompt sin cortarse.
    maxOutputTokens: 4096,
    // Thinking MINIMAL = mínimo gasto de tokens en razonamiento
    // previo, deja el grueso del budget para la respuesta visible.
    // Con LOW se comía ~2300 tokens y dejaba la respuesta en ~100.
    thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
    // Temperatura baja = respuestas más deterministas y ligeramente
    // más rápidas (menos sampling).
    temperature: 0.3,
  };

  const MAX_ATTEMPTS = 2;
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await ai.models.generateContent({
        model: GEMINI_MODEL,
        contents,
        config,
      });
      const text = (response?.text ?? "").trim();
      if (!text) {
        throw new Error("Gemini no devolvió texto. Intenta grabar la pregunta con más claridad.");
      }
      return text;
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_ATTEMPTS && isTransientError(err)) {
        // Espera 4 s antes del reintento.
        await new Promise((resolve) => setTimeout(resolve, 4000));
        continue;
      }
      break;
    }
  }

  // Si llegamos acá, falló definitivamente. Mapeo a un mensaje en
  // español claro, sin JSON crudo en la UI.
  const detail = describeError(lastErr);
  const lower = detail.toLowerCase();
  if (
    lower.includes("api key") ||
    lower.includes("auth") ||
    lower.includes("credential") ||
    lower.includes("permission") ||
    lower.includes("401") ||
    lower.includes("403")
  ) {
    throw new Error(`API Key rechazada por Gemini: ${detail}`);
  }
  if (lower.includes("quota") || lower.includes("429") || lower.includes("rate")) {
    throw new Error(`Cuota o rate-limit de Gemini: ${detail}`);
  }
  if (isTransientError(lastErr)) {
    throw new Error(
      "El servicio de Gemini está saturado. Reintentá en unos minutos. " +
        `Detalle: ${detail}`
    );
  }
  if (lower.includes("network") || lower.includes("fetch") || lower.includes("econn") || lower.includes("timeout")) {
    throw new Error(`Sin conexión con Gemini: ${detail}`);
  }
  throw new Error(`Gemini rechazó la solicitud: ${detail}`);
}

/**
 * Transcribe LITERALMENTE el audio a texto (español rioplatense).
 *
 * Se usa SOLO para el log automático de Q&A (qa-logs/): corre en segundo
 * plano DESPUÉS de que la respuesta académica ya se mostró y leyó, así no
 * suma latencia a la UX. Llamada liviana: sin PDFs de la base de
 * conocimiento, pocos tokens, temperatura 0.
 *
 * Devuelve la transcripción verbatim (sin timecodes ni etiquetas de
 * hablante). Lanza si Gemini no devuelve texto — el llamador debe hacer
 * fallback a guardar el log sin transcripción, nunca mostrar error al alumno.
 */
/**
 * Prompt de transcripción: reforzado para impedir razonamiento verbal.
 * Lo que va entre `<<T>>...<</T>>` es lo único que la app va a leer;
 * si el modelo "piensa en voz alta", esa parte queda afuera.
 */
const TRANSCRIBE_INSTRUCTION =
  "Tu ÚNICA tarea es transcribir LITERALMENTE el audio adjunto al texto, en español.\n" +
  "REGLA ABSOLUTA: tu respuesta completa debe consistir EXCLUSIVAMENTE en la transcripción, " +
  "encerrada entre los marcadores `<<T>>` y `<</T>>`. No escribas nada fuera de esos marcadores.\n" +
  "PROHIBIDO terminantemente incluir: razonamientos, justificaciones, verificaciones, " +
  "frases del estilo 'Let's verify', 'Wait', 'I hear', 'Escucho', 'Verifico', " +
  "'Let me check', 'Let me re-listen', 'He says', 'He spells', 'Audio contents', " +
  "'Let's transcribe verbatim', 'Let's write', prefijos tipo 'Transcripción:', " +
  "markdown, viñetas, timecodes o etiquetas de hablante.\n" +
  "Si hay fragmentos inaudibles, márcalos con [inaudible] dentro del bloque.\n" +
  "Ejemplo de output válido:\n<<T>>¿Qué droga facilita la adhesión a GABA? 1. Benzodiazepinas. 2. Ansiolíticos. 3. Antipsicóticos.<</T>>";

/**
 * Saca el contenido entre los marcadores `<<T>>` y `<</T>>`.
 * Si no aparecen, devuelve el texto completo (fallback).
 */
function extractTranscriptBlock(text: string): string | null {
  const m = text.match(/<<T>>([\s\S]*?)<<\/T>>/);
  return m ? m[1].trim() : null;
}

/**
 * Filtro defensivo de la transcripción: descarta líneas que parecen
 * razonamiento del modelo ("Let's...", "Wait...", "He says...", etc.)
 * y se queda con el contenido limpio. Se aplica DESPUÉS de `sanitizeResponseText`.
 *
 * Si el prompt se cumplió y el output viene limpio, devuelve el texto tal cual.
 * Si el modelo igual filtró ruido, intenta reconstruir la pregunta real
 * descartando las líneas de "thinking".
 */
export function cleanTranscript(raw: string): string {
  if (!raw) return raw;

  // 1) Si el modelo respetó los marcadores `<<T>>`, usar eso directamente.
  const block = extractTranscriptBlock(raw);
  const source = block ?? raw;

  const lines = source
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length <= 1) return source.trim();

  // 2) Patrones que delatan razonamiento verbal del modelo. Si la línea
  //    empieza con alguno de estos prefijos (en ES o EN), la descartamos.
  const reasoningPrefixes = [
    "let's", "let me", "now,", "now ", "wait", "wait,",
    "first,", "ok,", "okay,", "yes,", "sure,",
    "listen", "i hear", "i need", "i should",
    "the user", "audio contents", "audio:",
    "verify", "verifico", "escucho", "verific",
    "he says", "he spells", "he reads", "he literally",
    "she says", "she spells",
    "let's transcribe", "let's verify", "let's check",
    "let's write", "let's listen", "let's carefully",
    "let's double", "let's re", "let's re-listen",
    "transcripción:", "transcripcion:", "respuesta:",
    "carefully", "double check", "double-check",
    "i'll", "i will",
  ];

  const isReasoning = (line: string): boolean => {
    const lower = line.toLowerCase();
    return reasoningPrefixes.some((p) => lower.startsWith(p));
  };

  const cleaned = lines.filter((l) => !isReasoning(l));

  if (cleaned.length === 0) {
    // Nada sobrevivió: devolvemos el bloque original como último recurso.
    return source.trim();
  }

  // 3) Si después de filtrar todavía quedan varias líneas, preferir las que
  //    parezcan pregunta real (empiezan con ¿, o contienen ?  cerca del final,
  //    o empiezan con mayúscula + verbo interrogativo típico, o listan opciones
  //    numeradas tipo "1. X. 2. Y.").
  const looksLikeQuestion = (line: string): boolean => {
    if (line.startsWith("¿")) return true;
    if (/\?\s*(\d+\.|[\s"])/.test(line)) return true;
    if (/^\d+\.\s+\S/.test(line)) return true;
    if (/^[A-ZÁÉÍÓÚÑ][^.]*\?/.test(line)) return true;
    return false;
  };

  const questionLines = cleaned.filter(looksLikeQuestion);
  if (questionLines.length > 0) {
    return questionLines.join(" ").replace(/\s+/g, " ").trim();
  }

  // 4) Si ninguna línea parece pregunta, devolver la línea más larga
  //    (suele ser la transcripción verbatim).
  return cleaned.reduce((a, b) => (b.length > a.length ? b : a), "").trim();
}

export async function transcribeAudio(
  base64Audio: string,
  mimeType: string,
  apiKey: string
): Promise<string> {
  const cleanKey = apiKey.trim();
  if (!cleanKey || cleanKey === "TU_API_KEY_AQUI") {
    throw new Error("Sin API Key para transcribir.");
  }
  const ai = new GoogleGenAI({ apiKey: cleanKey });
  const response = await ai.models.generateContent({
    model: GEMINI_MODEL,
    contents: [
      {
        parts: [
          { inlineData: { mimeType, data: base64Audio } },
          { text: TRANSCRIBE_INSTRUCTION },
        ],
      },
    ],
    config: {
      maxOutputTokens: 600,
      temperature: 0,
      thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
    },
  });
  const sanitized = sanitizeResponseText((response?.text ?? "").trim());
  if (!sanitized) {
    throw new Error("Transcripción vacía.");
  }
  const cleaned = cleanTranscript(sanitized);
  return cleaned;
}

/** Cuenta palabras separadas por espacios (igual criterio que la UI). */
export function countWords(text: string): number {
  const t = (text ?? "").trim();
  if (!t) return 0;
  return t.split(/\s+/).length;
}

/**
 * Ampliación automática: helper conservado por compatibilidad.
 *
 * El system prompt actual (Cátedra Politis) define formatos estructurados
 * cortos (Multiple Choice / Verdadero-Falso / Cloze) y NO exige extensión
 * mínima de palabras, por lo que la app no llama a esta función. La
 * dejamos exportada para evitar romper importadores externos y para que
 * se pueda reutilizar si en el futuro se agrega un modo de respuesta
 * extensa al tutor.
 */
export async function expandAnswer(
  previousAnswer: string,
  apiKey: string,
  onProgress?: (msg: string) => void
): Promise<string> {
  const cleanKey = apiKey.trim();
  if (!cleanKey || cleanKey === "TU_API_KEY_AQUI") {
    throw new Error("Sin API Key para ampliar.");
  }
  const ai = new GoogleGenAI({ apiKey: cleanKey });
  onProgress?.("Ampliando respuesta…");
  const pdfParts = await buildKnowledgeBaseParts(ai, onProgress);
  const response = await ai.models.generateContent({
    model: GEMINI_MODEL,
    contents: [
      {
        parts: [
          ...pdfParts,
          {
            text:
              "Tu respuesta anterior fue correcta pero podés profundizarla con más detalle " +
              "técnico del programa (autores, modelos, pruebas). Mantené el formato estructurado " +
              "definido en el system prompt y devolvé la respuesta COMPLETA:\n\n" +
              previousAnswer,
          },
        ],
      },
    ],
    config: {
      systemInstruction: SYSTEM_PROMPT,
      maxOutputTokens: 2400,
      thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
      temperature: 0.3,
    },
  });
  const text = sanitizeResponseText((response?.text ?? "").trim());
  if (!text) {
    throw new Error("Ampliación vacía.");
  }
  return text;
}

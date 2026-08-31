import type { Env } from "../env.ts";
import type { ProjectSnapshot, StructuringResult } from "../../shared/types.ts";
import { HttpError } from "../util.ts";

const CLAUDE_MODEL = "claude-sonnet-5";
// Adaptive thinking (Sonnet 5's default when `thinking` is omitted) consumed
// up to ~900 of a 2000-token budget on compound multi-request transcripts,
// risking a mid-JSON truncation. Disabled for deterministic, bounded output;
// max_tokens raised as extra headroom now that thinking won't eat into it.
const CLAUDE_MAX_TOKENS = 4096;
const CLAUDE_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

const SYSTEM_PROMPT = `Ты помогаешь структурировать голосовые заметки в задачи для таск-менеджера проекта
Heimwacht (сайт для продажи и установки оборудования Ajax Systems в Германии, Next.js +
Cloudflare Workers + D1).

Тебе дан снэпшот текущего состояния проекта (все доски, колонки, задачи с id,
существующие связи) и транскрипт новой голосовой заметки.

Твоя задача:
1. Извлечь из транскрипта конкретные, выполнимые задачи (не абстрактные пожелания).
2. Для каждой новой задачи предложить, в какую доску/колонку она логично ложится
(используй существующие названия колонок из снэпшота, не выдумывай новые).
3. Предложить связи с уже существующими задачами, используя ТОЛЬКО task_id из снэпшота.
Тип связи: "blocks", "related", "duplicate". Укажи направление явно.
4. Если в заметке есть нерешённый вопрос — вынеси в open_questions, НЕ создавай как задачу.
5. Если задача дублирует существующую по смыслу — не создавай новую, отметь как duplicate.
6. Всегда пиши title и description на английском, независимо от языка транскрипта — для
консистентности с существующими задачами в системе.

A single voice note may contain multiple distinct, unrelated requests. Evaluate and
process each request independently — do not let one request (e.g. a status change)
cause other requests (e.g. new task creation) in the same note to be skipped.

A request to change the status, column, or completion state of an EXISTING task
(e.g. "move this to Done", "mark it as finished") is not a request to create a new
task. The output format has no way to represent an edit to an existing task — always
route such requests to open_questions instead of new_tasks, referencing the existing
task_id in the context field.

Отвечай СТРОГО в JSON, без преамбулы и markdown-обёртки:
{
  "new_tasks": [
    {
      "title": "string",
      "description": "string",
      "suggested_board": "string, точное имя доски из снэпшота",
      "suggested_column": "string, точное имя колонки из снэпшота",
      "links": [{ "task_id": "string", "relation_type": "blocks|related|duplicate", "direction": "this_blocks_that|that_blocks_this" }],
      "confidence": "high|medium|low"
    }
  ],
  "open_questions": [{ "question": "string", "context": "string" }]
}`;

/**
 * Renders a project snapshot as a compact, human-readable outline for the
 * prompt. Every column is listed — including empty ones, marked "(empty)" —
 * so the model always sees the full set of valid suggested_column values,
 * not just columns that already happen to contain a task.
 */
export function formatSnapshotForPrompt(snapshot: ProjectSnapshot): string {
  const lines: string[] = [];
  for (const board of snapshot.boards) {
    for (const column of board.columns) {
      if (column.tasks.length === 0) {
        lines.push(`${board.name} / ${column.name} (empty)`);
        continue;
      }
      lines.push(`${board.name} / ${column.name}:`);
      for (const task of column.tasks) {
        const desc = task.description ? ` — ${task.description}` : "";
        lines.push(`  - [${task.id}] ${task.title}${desc}`);
      }
    }
  }
  if (snapshot.links.length > 0) {
    lines.push("", "Existing links:");
    for (const link of snapshot.links) {
      lines.push(`- [${link.from_task_id}] ${link.relation_type} [${link.to_task_id}]`);
    }
  }
  return lines.length > 0 ? lines.join("\n") : "(no existing boards/tasks yet)";
}

/**
 * Extracts the first balanced top-level JSON object from the model's reply.
 * The prompt asks for raw JSON, but models sometimes wrap it in a markdown
 * fence and/or add prose before or after it anyway — scan for the object
 * instead of assuming the whole string is clean JSON.
 */
function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const start = trimmed.indexOf("{");
  if (start === -1) throw new Error("No JSON object found in response");

  let depth = 0;
  let inString = false;
  let escaped = false;
  let end = -1;
  for (let i = start; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) throw new Error("Unbalanced JSON object in response");
  return JSON.parse(trimmed.slice(start, end + 1));
}

function isValidResult(value: unknown): value is StructuringResult {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return Array.isArray(v.new_tasks) && Array.isArray(v.open_questions);
}

async function callClaude(
  system: string,
  userMessage: string,
  apiKey: string,
): Promise<string> {
  const res = await fetch(CLAUDE_API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: CLAUDE_MAX_TOKENS,
      thinking: { type: "disabled" },
      system,
      messages: [{ role: "user", content: userMessage }],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new HttpError(502, `Claude API error (${res.status}): ${body.slice(0, 300)}`);
  }
  const data = (await res.json()) as { content: { type: string; text?: string }[] };
  const text = data.content.find((c) => c.type === "text")?.text;
  if (!text) throw new HttpError(502, "Claude API returned no text content");
  return text;
}

/**
 * Sends the transcript + a single board's snapshot to Claude and returns
 * structured task proposals. Retries once if the model's reply isn't valid
 * JSON. boardName is mandatory — boards are separate client projects and the
 * model must never see or suggest tasks for any board but the one requested.
 */
export async function structureTranscript(
  transcript: string,
  snapshot: ProjectSnapshot,
  env: Env,
  boardName: string,
): Promise<StructuringResult> {
  const snapshotText = formatSnapshotForPrompt(snapshot);
  const userMessage = `Снэпшот проекта:\n${snapshotText}\n\nТранскрипт голосовой заметки:\n${transcript}`;
  const systemPrompt = `${SYSTEM_PROMPT}\n\nAll tasks from this note belong to board '${boardName}'. Do not reference or suggest tasks for any other board.`;

  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const text = await callClaude(systemPrompt, userMessage, env.ANTHROPIC_API_KEY);
    try {
      const parsed = extractJson(text);
      if (isValidResult(parsed)) return parsed;
      lastError = new Error("Response JSON did not match the expected shape");
    } catch (e) {
      lastError = e;
    }
  }
  throw new HttpError(
    502,
    `Claude returned an invalid response after retry: ${String(lastError)}`,
  );
}

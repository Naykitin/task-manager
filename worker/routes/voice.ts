import type { Env } from "../env.ts";
import type { ApplyLinkInput, ApplyNewTaskInput, VoiceNote } from "../../shared/types.ts";
import { assertColumnOwner, assertTaskOwner } from "../db.ts";
import { buildInsertTaskStmt, getProjectSnapshot, loadTask } from "./tasks.ts";
import { structureTranscript } from "../lib/structuring.ts";
import { HttpError, json, newId, nowIso, readJson, requireString } from "../util.ts";

const RELATION_TYPES = ["blocks", "related", "duplicate"];
const DIRECTIONS = ["this_blocks_that", "that_blocks_this"];

/** POST /api/voice-notes — store a raw transcript, status starts as 'pending'. */
export async function createVoiceNote(
  req: Request,
  userId: string,
  env: Env,
): Promise<Response> {
  const body = await readJson<{ transcript?: string; audio_url?: string }>(req);
  const transcript = requireString(body.transcript, "transcript", { max: 20_000 });
  const audioUrl =
    typeof body.audio_url === "string" && body.audio_url.trim()
      ? body.audio_url.trim()
      : null;

  const id = newId();
  await env.DB.prepare(
    "INSERT INTO voice_notes (id, user_id, audio_url, transcript, status) VALUES (?, ?, ?, ?, 'pending')",
  )
    .bind(id, userId, audioUrl, transcript)
    .run();

  const note = await env.DB.prepare(
    `SELECT id, user_id, audio_url, transcript, status, created_at, reviewed_at
       FROM voice_notes WHERE id = ?`,
  )
    .bind(id)
    .first<VoiceNote>();
  return json({ note }, { status: 201 });
}

/** GET /api/voice-notes?status=pending — list the user's voice notes. */
export async function listVoiceNotes(
  url: URL,
  userId: string,
  env: Env,
): Promise<Response> {
  const status = url.searchParams.get("status");
  const validStatuses = ["pending", "reviewed", "discarded"];
  if (status && !validStatuses.includes(status)) {
    throw new HttpError(400, "Invalid status filter");
  }

  const query = status
    ? env.DB.prepare(
        `SELECT id, user_id, audio_url, transcript, status, created_at, reviewed_at
           FROM voice_notes WHERE user_id = ? AND status = ?
          ORDER BY created_at DESC`,
      ).bind(userId, status)
    : env.DB.prepare(
        `SELECT id, user_id, audio_url, transcript, status, created_at, reviewed_at
           FROM voice_notes WHERE user_id = ?
          ORDER BY created_at DESC`,
      ).bind(userId);

  const { results } = await query.all<VoiceNote>();
  return json({ notes: results });
}

async function assertVoiceNoteOwner(
  env: Env,
  userId: string,
  noteId: string,
): Promise<VoiceNote> {
  const note = await env.DB.prepare(
    `SELECT id, user_id, audio_url, transcript, status, created_at, reviewed_at
       FROM voice_notes WHERE id = ? AND user_id = ?`,
  )
    .bind(noteId, userId)
    .first<VoiceNote>();
  if (!note) throw new HttpError(404, "Voice note not found");
  return note;
}

/**
 * POST /api/voice-notes/:id/structure — preview only. Sends the transcript
 * plus the snapshot of ONE board to Claude and returns its suggestions
 * as-is; nothing is written to tasks/task_links here.
 *
 * Boards are separate, unrelated client projects (e.g. "Ajax Systems" vs
 * "Collagenica") — the snapshot sent to the model is always scoped to the
 * requested board_id, never the user's whole project, so context never
 * mixes across clients.
 */
export async function structureVoiceNote(
  req: Request,
  noteId: string,
  userId: string,
  env: Env,
): Promise<Response> {
  const note = await assertVoiceNoteOwner(env, userId, noteId);
  const body = await readJson<{ board_id?: string }>(req);
  const boardId = requireString(body.board_id, "board_id");

  const snapshot = await getProjectSnapshot(env, userId);
  const board = snapshot.boards.find((b) => b.id === boardId);
  if (!board) throw new HttpError(404, "Board not found");

  const taskIds = new Set(board.columns.flatMap((c) => c.tasks.map((t) => t.id)));
  const boardSnapshot = {
    boards: [board],
    links: snapshot.links.filter(
      (l) => taskIds.has(l.from_task_id) && taskIds.has(l.to_task_id),
    ),
  };

  const result = await structureTranscript(note.transcript, boardSnapshot, env, board.name);
  return json(result);
}

function validateApplyLink(link: unknown): ApplyLinkInput {
  if (!link || typeof link !== "object") {
    throw new HttpError(400, "Each link must be an object");
  }
  const l = link as Record<string, unknown>;
  const taskId = requireString(l.task_id, "links[].task_id");
  if (typeof l.relation_type !== "string" || !RELATION_TYPES.includes(l.relation_type)) {
    throw new HttpError(400, "links[].relation_type must be blocks|related|duplicate");
  }
  if (typeof l.direction !== "string" || !DIRECTIONS.includes(l.direction)) {
    throw new HttpError(
      400,
      "links[].direction must be this_blocks_that|that_blocks_this",
    );
  }
  return {
    task_id: taskId,
    relation_type: l.relation_type as ApplyLinkInput["relation_type"],
    direction: l.direction as ApplyLinkInput["direction"],
  };
}

function validateApplyNewTask(input: unknown): ApplyNewTaskInput {
  if (!input || typeof input !== "object") {
    throw new HttpError(400, "Each entry in new_tasks must be an object");
  }
  const t = input as Record<string, unknown>;
  const title = requireString(t.title, "title", { max: 500 });
  const description =
    typeof t.description === "string" && t.description.trim() ? t.description.trim() : undefined;
  const columnId = requireString(t.column_id, "column_id");
  const links = Array.isArray(t.links) ? t.links.map(validateApplyLink) : [];
  return { title, description, column_id: columnId, links };
}

/**
 * POST /api/voice-notes/:id/apply — creates the reviewed/edited new_tasks
 * (with source='ai_voice' + origin_voice_note_id) and their task_links, and
 * marks the voice note 'reviewed'. Everything runs in a single D1 batch so a
 * failure never leaves a partially-applied result.
 */
export async function applyVoiceNote(
  req: Request,
  noteId: string,
  userId: string,
  env: Env,
): Promise<Response> {
  await assertVoiceNoteOwner(env, userId, noteId);
  const body = await readJson<{ new_tasks?: unknown }>(req);
  if (!Array.isArray(body.new_tasks) || body.new_tasks.length === 0) {
    throw new HttpError(400, "new_tasks must be a non-empty array");
  }
  const newTasks = body.new_tasks.map(validateApplyNewTask);

  // Verify ownership of every target column and every linked existing task
  // up front — these are read-only checks, not part of the write batch.
  const columnIds = [...new Set(newTasks.map((t) => t.column_id))];
  for (const columnId of columnIds) {
    await assertColumnOwner(env, userId, columnId);
  }
  for (const t of newTasks) {
    for (const link of t.links ?? []) {
      await assertTaskOwner(env, userId, link.task_id);
    }
  }

  // Starting position per target column, incremented locally as tasks are
  // assigned so multiple new tasks can land in the same column in one call.
  const nextPositionByColumn = new Map<string, number>();
  for (const columnId of columnIds) {
    const row = await env.DB.prepare(
      "SELECT COALESCE(MAX(position), -1) + 1 AS pos FROM tasks WHERE column_id = ?",
    )
      .bind(columnId)
      .first<{ pos: number }>();
    nextPositionByColumn.set(columnId, row?.pos ?? 0);
  }

  const stmts: D1PreparedStatement[] = [];
  const createdTaskIds: string[] = [];

  for (const t of newTasks) {
    const id = newId();
    const position = nextPositionByColumn.get(t.column_id) ?? 0;
    nextPositionByColumn.set(t.column_id, position + 1);

    createdTaskIds.push(id);
    stmts.push(
      buildInsertTaskStmt(env, {
        id,
        columnId: t.column_id,
        title: t.title,
        description: t.description ?? null,
        position,
        source: "ai_voice",
        originVoiceNoteId: noteId,
      }),
    );

    for (const link of t.links ?? []) {
      const [fromTaskId, toTaskId] =
        link.direction === "that_blocks_this" ? [link.task_id, id] : [id, link.task_id];
      stmts.push(
        env.DB.prepare(
          "INSERT INTO task_links (id, from_task_id, to_task_id, relation_type) VALUES (?, ?, ?, ?)",
        ).bind(newId(), fromTaskId, toTaskId, link.relation_type),
      );
    }
  }

  stmts.push(
    env.DB.prepare("UPDATE voice_notes SET status = 'reviewed', reviewed_at = ? WHERE id = ?").bind(
      nowIso(),
      noteId,
    ),
  );

  await env.DB.batch(stmts);

  const tasks = await Promise.all(createdTaskIds.map((id) => loadTask(env, id)));
  return json({ tasks });
}

import { useEffect, useRef, useState } from "react";
import type {
  ApplyNewTaskInput,
  BoardDetail,
  StructuredLink,
  Task,
} from "../../shared/types.ts";
import { api } from "../api.ts";

interface ReviewItem {
  include: boolean;
  title: string;
  description: string;
  columnId: string;
  links: StructuredLink[];
}

function findColumnId(board: BoardDetail, columnName: string): string {
  return board.columns.find((c) => c.name === columnName)?.id ?? "";
}

function taskTitleById(board: BoardDetail, taskId: string): string {
  for (const column of board.columns) {
    const task = column.tasks.find((t) => t.id === taskId);
    if (task) return task.title;
  }
  return taskId;
}

function linkLabel(link: StructuredLink, board: BoardDetail): string {
  return `${link.relation_type}: ${taskTitleById(board, link.task_id)}`;
}

// ---- Minimal Web Speech API typing (not part of lib.dom.d.ts) ----

interface SpeechRecognitionResultLike {
  isFinal: boolean;
  0: { transcript: string };
}

interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: { length: number; [index: number]: SpeechRecognitionResultLike };
}

interface SpeechRecognitionErrorEventLike {
  error: string;
}

interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** Human-readable text for the Web Speech API's `error` codes. */
function describeSpeechError(code: string): string {
  switch (code) {
    case "not-allowed":
    case "permission-denied":
      return "Microphone access denied — allow it in your browser's site settings and try again.";
    case "no-speech":
      return "No speech detected — try again.";
    case "audio-capture":
      return "No microphone found.";
    case "network":
      return "Speech recognition network error — check your connection.";
    case "language-not-supported":
      return "This browser's speech engine doesn't support the selected language.";
    case "aborted":
      return "Speech recognition was interrupted.";
    default:
      return `Speech recognition failed: ${code}`;
  }
}

function appendTranscript(prev: string, addition: string): string {
  const trimmed = addition.trim();
  if (!trimmed) return prev;
  return prev.trim() ? `${prev.trimEnd()} ${trimmed}` : trimmed;
}

interface Props {
  /** Every voice note is scoped to exactly one board — boards are separate,
   * unrelated client projects and must never share AI context. */
  boardId: string;
  /** Called with the tasks created by a successful apply, e.g. to reload the board. */
  onApplied?: (tasks: Task[]) => void;
}

export function VoiceInbox({ boardId, onApplied }: Props) {
  const [transcript, setTranscript] = useState("");
  const [structuring, setStructuring] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [board, setBoard] = useState<BoardDetail | null>(null);
  const [noteId, setNoteId] = useState<string | null>(null);
  const [items, setItems] = useState<ReviewItem[] | null>(null);
  const [openQuestions, setOpenQuestions] = useState<
    { question: string; context: string }[]
  >([]);

  const [applying, setApplying] = useState(false);
  const [appliedTasks, setAppliedTasks] = useState<Task[] | null>(null);

  const [listening, setListening] = useState(false);
  const [speechError, setSpeechError] = useState<string | null>(null);
  const [speechLang, setSpeechLang] = useState(""); // "" = auto (navigator.language)
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  // Text from the latest non-final result, in case stop() ends the session
  // before the engine ever marks that last utterance as isFinal — otherwise
  // it would be silently dropped instead of landing in the textarea.
  const pendingInterimRef = useRef("");
  const speechCtor = getSpeechRecognitionCtor();
  const isSecureContext = typeof window === "undefined" || window.isSecureContext;

  useEffect(() => {
    return () => recognitionRef.current?.stop();
  }, []);

  function flushPendingInterim() {
    if (!pendingInterimRef.current.trim()) return;
    setTranscript((prev) => appendTranscript(prev, pendingInterimRef.current));
    pendingInterimRef.current = "";
  }

  function startListening() {
    if (!speechCtor) return;
    setSpeechError(null);
    pendingInterimRef.current = "";
    const recognition = new speechCtor();
    recognition.lang = speechLang || navigator.language || "en-US";
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.onresult = (event) => {
      let finalText = "";
      let interimText = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) finalText += result[0].transcript;
        else interimText += result[0].transcript;
      }
      if (finalText.trim()) {
        setTranscript((prev) => appendTranscript(prev, finalText));
        pendingInterimRef.current = "";
      } else if (interimText.trim()) {
        pendingInterimRef.current = interimText;
      }
    };
    recognition.onerror = (event) => {
      setListening(false);
      setSpeechError(describeSpeechError(event.error));
    };
    recognition.onend = () => {
      setListening(false);
      flushPendingInterim();
    };
    recognition.start();
    recognitionRef.current = recognition;
    setListening(true);
  }

  function stopListening() {
    recognitionRef.current?.stop();
  }

  async function handleStructure() {
    if (!transcript.trim()) {
      setError("Paste or type a transcript first");
      return;
    }
    setStructuring(true);
    setError(null);
    setAppliedTasks(null);
    try {
      const [{ note }, { board: b }] = await Promise.all([
        api.createVoiceNote(transcript.trim()),
        api.getBoard(boardId),
      ]);
      const result = await api.structureVoiceNote(note.id, boardId);
      setNoteId(note.id);
      setBoard(b);
      setOpenQuestions(result.open_questions);
      setItems(
        result.new_tasks.map((t) => ({
          include: true,
          title: t.title,
          description: t.description,
          columnId: findColumnId(b, t.suggested_column),
          links: t.links,
        })),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to structure transcript");
    } finally {
      setStructuring(false);
    }
  }

  function updateItem(index: number, patch: Partial<ReviewItem>) {
    setItems((prev) =>
      prev ? prev.map((it, i) => (i === index ? { ...it, ...patch } : it)) : prev,
    );
  }

  async function handleApply() {
    if (!noteId || !items) return;
    const selected = items.filter((it) => it.include);
    if (selected.length === 0) {
      setError("Select at least one task to apply");
      return;
    }
    if (selected.some((it) => !it.columnId)) {
      setError("Every selected task needs a column — pick one from the dropdown");
      return;
    }
    setApplying(true);
    setError(null);
    try {
      const payload: ApplyNewTaskInput[] = selected.map((it) => ({
        title: it.title.trim(),
        description: it.description.trim() || undefined,
        column_id: it.columnId,
        links: it.links,
      }));
      const { tasks } = await api.applyVoiceNote(noteId, payload);
      setAppliedTasks(tasks);
      setItems(null);
      setOpenQuestions([]);
      setTranscript("");
      onApplied?.(tasks);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to apply");
    } finally {
      setApplying(false);
    }
  }

  return (
    <div className="voice-inbox">
      <label className="field">
        <span>Voice note transcript</span>
        <textarea
          rows={6}
          value={transcript}
          onChange={(e) => setTranscript(e.target.value)}
          placeholder="Paste or type what was said…"
        />
      </label>

      <div className="voice-mic-row">
        {speechCtor && (
          <>
            {listening ? (
              <button
                type="button"
                className="btn danger sm mic-btn listening"
                onClick={stopListening}
              >
                ⏹ Stop
              </button>
            ) : (
              <button type="button" className="btn ghost sm mic-btn" onClick={startListening}>
                🎤 Dictate
              </button>
            )}
            <select
              className="mic-lang-select"
              value={speechLang}
              disabled={listening}
              onChange={(e) => setSpeechLang(e.target.value)}
              title="Speech recognition language"
            >
              <option value="">Auto ({navigator.language || "en-US"})</option>
              <option value="ru-RU">Russian (ru-RU)</option>
              <option value="en-US">English (en-US)</option>
            </select>
          </>
        )}
        {!speechCtor && !isSecureContext && (
          <span className="voice-mic-warning">
            Voice dictation needs HTTPS (or localhost) — this page was loaded over an
            insecure connection.
          </span>
        )}
        <button className="btn primary" onClick={handleStructure} disabled={structuring}>
          {structuring ? "Structuring…" : "Structure"}
        </button>
      </div>
      {speechError && <div className="voice-mic-error">{speechError}</div>}

      {error && <div className="banner-error">{error}</div>}

      {appliedTasks && (
        <div className="voice-applied">
          Applied {appliedTasks.length} task
          {appliedTasks.length === 1 ? "" : "s"}: {appliedTasks.map((t) => t.title).join(", ")}
        </div>
      )}

      {items && board && (
        <div className="voice-review">
          <h3>Proposed tasks</h3>
          {items.length === 0 ? (
            <div className="muted">No tasks were extracted from this transcript.</div>
          ) : (
            items.map((item, i) => (
              <div className="voice-task-row" key={i}>
                <input
                  type="checkbox"
                  checked={item.include}
                  onChange={(e) => updateItem(i, { include: e.target.checked })}
                />
                <div className="voice-task-fields">
                  <input
                    value={item.title}
                    maxLength={500}
                    onChange={(e) => updateItem(i, { title: e.target.value })}
                  />
                  <textarea
                    rows={2}
                    value={item.description}
                    onChange={(e) => updateItem(i, { description: e.target.value })}
                  />
                  <select
                    value={item.columnId}
                    onChange={(e) => updateItem(i, { columnId: e.target.value })}
                  >
                    <option value="">— choose a column —</option>
                    {board.columns.map((column) => (
                      <option key={column.id} value={column.id}>
                        {column.name}
                      </option>
                    ))}
                  </select>
                  {item.links.length > 0 && (
                    <ul className="voice-links">
                      {item.links.map((link, li) => (
                        <li key={li}>{linkLabel(link, board)}</li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            ))
          )}

          {openQuestions.length > 0 && (
            <>
              <h3>Open questions</h3>
              <ul className="voice-open-questions">
                {openQuestions.map((q, i) => (
                  <li key={i}>
                    <strong>{q.question}</strong>
                    <div className="muted">{q.context}</div>
                  </li>
                ))}
              </ul>
            </>
          )}

          <button className="btn primary" onClick={handleApply} disabled={applying}>
            {applying ? "Applying…" : "Apply selected"}
          </button>
        </div>
      )}
    </div>
  );
}

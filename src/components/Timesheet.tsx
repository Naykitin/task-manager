import { useCallback, useEffect, useState } from "react";
import type { TimesheetResponse } from "../../shared/types.ts";
import { api } from "../api.ts";
import {
  formatDate,
  formatDuration,
  formatHours,
  monthRange,
  toYmd,
} from "../format.ts";

export function Timesheet() {
  const initial = monthRange(new Date());
  const [start, setStart] = useState(initial.start);
  const [end, setEnd] = useState(initial.end);
  const [data, setData] = useState<TimesheetResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (s: string, e: string) => {
    setLoading(true);
    setError(null);
    try {
      setData(await api.timesheet(s, e));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load timesheet");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(start, end);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function shiftMonth(delta: number) {
    const [y, m] = start.split("-").map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    const r = monthRange(d);
    setStart(r.start);
    setEnd(r.end);
    load(r.start, r.end);
  }

  function thisMonth() {
    const r = monthRange(new Date());
    setStart(r.start);
    setEnd(r.end);
    load(r.start, r.end);
  }

  return (
    <div className="timesheet">
      <div className="ts-toolbar">
        <div className="ts-range">
          <button className="btn ghost sm" onClick={() => shiftMonth(-1)}>
            ‹ Prev
          </button>
          <button className="btn ghost sm" onClick={thisMonth}>
            This month
          </button>
          <button className="btn ghost sm" onClick={() => shiftMonth(1)}>
            Next ›
          </button>
        </div>
        <div className="ts-dates">
          <label>
            From
            <input
              type="date"
              value={start}
              max={end}
              onChange={(e) => setStart(e.target.value)}
            />
          </label>
          <label>
            To
            <input
              type="date"
              value={end}
              min={start}
              max={toYmd(new Date(2100, 0, 1))}
              onChange={(e) => setEnd(e.target.value)}
            />
          </label>
          <button className="btn primary sm" onClick={() => load(start, end)}>
            Apply
          </button>
        </div>
        <a
          className="btn accent sm"
          href={api.timesheetExportUrl(start, end)}
          download
        >
          ⬇ Export CSV
        </a>
      </div>

      {error && <div className="banner-error">{error}</div>}

      {loading || !data ? (
        <div className="center-pad">
          <div className="spinner" />
        </div>
      ) : (
        <>
          <div className="ts-summary">
            <div className="ts-card big">
              <div className="ts-label">Total for period</div>
              <div className="ts-value">
                {formatDuration(data.total_seconds)}
              </div>
              <div className="ts-sub">
                {formatHours(data.total_seconds)} hours ·{" "}
                {data.start} → {data.end}
              </div>
            </div>
            {data.in_progress_seconds > 0 && (
              <div className="ts-card warn">
                <div className="ts-label">In progress (not counted)</div>
                <div className="ts-value">
                  {formatDuration(data.in_progress_seconds)}
                </div>
                <div className="ts-sub">A timer is currently running</div>
              </div>
            )}
          </div>

          <div className="ts-grid">
            <div className="ts-panel">
              <h3>By task</h3>
              {data.by_task.length === 0 ? (
                <div className="muted">No time in this period.</div>
              ) : (
                <table className="ts-table">
                  <thead>
                    <tr>
                      <th>Task</th>
                      <th>Board</th>
                      <th className="num">Hours</th>
                      <th className="num">Time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.by_task.map((t) => (
                      <tr key={t.task_id}>
                        <td>{t.task_title}</td>
                        <td className="muted">{t.board_name}</td>
                        <td className="num">
                          {formatHours(t.duration_seconds)}
                        </td>
                        <td className="num">
                          {formatDuration(t.duration_seconds)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div className="ts-panel">
              <h3>By board</h3>
              {data.by_board.length === 0 ? (
                <div className="muted">No time in this period.</div>
              ) : (
                <table className="ts-table">
                  <thead>
                    <tr>
                      <th>Board</th>
                      <th className="num">Hours</th>
                      <th className="num">Time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.by_board.map((b) => (
                      <tr key={b.board_id}>
                        <td>{b.board_name}</td>
                        <td className="num">
                          {formatHours(b.duration_seconds)}
                        </td>
                        <td className="num">
                          {formatDuration(b.duration_seconds)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>

          <div className="ts-panel">
            <h3>Day by day</h3>
            {data.days.length === 0 ? (
              <div className="empty-block">
                No time tracked in this period.
              </div>
            ) : (
              <div className="ts-days">
                {data.days.map((day) => (
                  <div key={day.date} className="ts-day">
                    <div className="ts-day-head">
                      <span className="ts-day-date">
                        {formatDate(day.date + "T00:00:00")}
                      </span>
                      <span className="ts-day-total">
                        {formatDuration(day.total_seconds)} ·{" "}
                        {formatHours(day.total_seconds)}h
                      </span>
                    </div>
                    <table className="ts-table compact">
                      <tbody>
                        {day.tasks.map((t) => (
                          <tr key={t.task_id}>
                            <td>{t.task_title}</td>
                            <td className="muted">{t.board_name}</td>
                            <td className="num">
                              {formatDuration(t.duration_seconds)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

import React, { useEffect, useState } from "react";
import { Task, PRIORITY_COLORS } from "../types";
import { capitalizeFirst, formatRelativeDays, formatShortDate, formatTime, isDateOnly, isSameLocalDay, parseStored } from "../dateFormat";

interface Props {
  tasks: Task[]; // already filtered to the current scope, includes subtasks
  selectedTaskId: string | null;
  onSelect: (id: string) => void;
  onToggleComplete: (id: string) => void;
  onContextMenu: (e: React.MouseEvent, taskId: string) => void;
  /** Manual sort mode only: rows become draggable. */
  dragEnabled?: boolean;
  onReorder?: (draggedId: string, targetId: string) => void;
}

function formatDue(due: string | null): { text: string; overdue: boolean } | null {
  if (!due) return null;
  // parseStored, not `new Date(due)`: the latter reads a date-only value as UTC
  // midnight, so west of UTC an all-day task due today rendered as yesterday
  // AND, failing the same-day test below, was styled overdue on its own day.
  const d = parseStored(due);
  if (!d) return null;
  const now = new Date();
  const hasTime = !isDateOnly(due);
  const isToday = isSameLocalDay(d, now);
  // Date-only tasks aren't overdue during their own day; timed tasks are
  // overdue the moment their time passes.
  const overdue = hasTime ? d < now : d < now && !isToday;
  // "Today" comes from Intl rather than a literal, so it follows the locale
  // ("heute", "aujourd'hui") like the date beside it already does.
  let text = isToday ? capitalizeFirst(formatRelativeDays(0)) : formatShortDate(d);
  if (hasTime) text += ` ${formatTime(d)}`;
  return { text, overdue };
}

export default function TaskTable({ tasks, selectedTaskId, onSelect, onToggleComplete, onContextMenu, dragEnabled = false, onReorder }: Props) {
  const topLevel = tasks.filter((t) => !t.parent_id);
  const childrenOf = (id: string) => tasks.filter((t) => t.parent_id === id);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  // Parents whose subtasks are collapsed (hidden). Persisted so the layout
  // survives reloads and list switches.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem("collapsedSubtasks") || "[]")); } catch { return new Set(); }
  });
  useEffect(() => {
    localStorage.setItem("collapsedSubtasks", JSON.stringify([...collapsed]));
  }, [collapsed]);
  function toggleCollapsed(id: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  if (topLevel.length === 0) {
    return <div className="empty-state">No tasks here. Press Ctrl+N to add one.</div>;
  }

  function renderRow(t: Task, depth: number) {
    const due = formatDue(t.due_date);
    const children = childrenOf(t.id);
    const isCollapsed = collapsed.has(t.id);
    return (
      <React.Fragment key={t.id}>
        <div
          className={`task-row ${depth > 0 ? "subtask" : ""} ${t.completed ? "completed" : ""} ${selectedTaskId === t.id ? "selected" : ""} ${dragOverId === t.id ? "drag-over" : ""}`}
          onClick={() => onSelect(t.id)}
          onContextMenu={(e) => onContextMenu(e, t.id)}
          draggable={dragEnabled}
          onDragStart={(e) => {
            if (!dragEnabled) return;
            e.dataTransfer.setData("text/task-id", t.id);
            e.dataTransfer.effectAllowed = "move";
          }}
          onDragOver={(e) => {
            if (!dragEnabled) return;
            e.preventDefault(); // required to allow dropping
            setDragOverId(t.id);
          }}
          onDragLeave={() => setDragOverId((cur) => (cur === t.id ? null : cur))}
          onDrop={(e) => {
            if (!dragEnabled) return;
            e.preventDefault();
            setDragOverId(null);
            const draggedId = e.dataTransfer.getData("text/task-id");
            if (draggedId && draggedId !== t.id) onReorder?.(draggedId, t.id);
          }}
          onDragEnd={() => setDragOverId(null)}
        >
          {children.length > 0 ? (
            <span
              className="subtask-toggle"
              title={isCollapsed ? "Expand subtasks" : "Collapse subtasks"}
              onClick={(e) => { e.stopPropagation(); toggleCollapsed(t.id); }}
            >{isCollapsed ? "▸" : "▾"}</span>
          ) : (
            <span className="subtask-toggle spacer" />
          )}
          <span
            className={`checkbox ${t.completed ? "done" : ""}`}
            onClick={(e) => { e.stopPropagation(); onToggleComplete(t.id); }}
          />
          {!t.completed && t.priority !== 0 && (
            <span className="priority-dot" style={{ background: PRIORITY_COLORS[t.priority] }} />
          )}
          <div className="title-col">
            <div className="title">{t.title}</div>
            <div className="meta">
              {due && <span className={due.overdue ? "overdue" : ""}>{due.overdue ? "Overdue · " : "Due "}{due.text}</span>}
              {t.recurrence && <span>↻ repeats</span>}
              {t.tags && <span>{t.tags}</span>}
              {children.length > 0 && <span>{children.filter((c) => c.completed).length}/{children.length} subtasks</span>}
            </div>
          </div>
        </div>
        {!isCollapsed && children.map((c) => renderRow(c, depth + 1))}
      </React.Fragment>
    );
  }

  return <div className="task-table">{topLevel.map((t) => renderRow(t, 0))}</div>;
}

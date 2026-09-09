import React, { useState, useEffect, useRef } from "react";
import { TaskList, Task } from "../types";
import ContextMenu from "./ContextMenu";

export interface SidebarSmartFilter {
  id: string;
  name: string;
}

interface Props {
  lists: TaskList[];
  tasks: Task[];
  accounts: { id: string; label: string }[];
  selectedListId: string | "all" | "today";
  onSelect: (id: string | "all" | "today") => void;
  onCreateList: (name: string) => void;
  onCreateServerList: (name: string, accountId: string) => Promise<void>;
  onOpenSettings: () => void;
  onSync: () => void;
  syncing: boolean;
  syncMsg?: string | null;
  forceAdding?: boolean;
  onForceAddingHandled?: () => void;
  onDeleteList: (id: string) => void;
  onRemoveList: (id: string) => void;
  onRenameList: (id: string, name: string) => void;
  onExportList: (id: string) => void;
  onSyncList: (accountId: string) => void;
  smartFilters?: SidebarSmartFilter[];
  onApplyFilter?: (f: any) => void;
  onDeleteFilter?: (id: string) => void;
  calendarListFilter?: string;
  onSetCalendarListFilter?: (id: string) => void;
  /** Experimental: when collapsed, only a thin "›" re-expand tab renders,
   *  freeing up width for the calendar/task table (mirrors the Today pane's
   *  collapse toggle on the other side of the window). */
  collapsed: boolean;
  onToggleCollapsed: () => void;
}

export default function Sidebar({
  lists,
  tasks,
  accounts,
  selectedListId,
  onSelect,
  onCreateList,
  onCreateServerList,
  onOpenSettings,
  onSync,
  syncing,
  syncMsg,
  forceAdding,
  onForceAddingHandled,
  onDeleteList,
  onRemoveList,
  onRenameList,
  onExportList,
  onSyncList,
  smartFilters = [],
  onApplyFilter,
  onDeleteFilter,
  calendarListFilter = "all",
  onSetCalendarListFilter,
  collapsed,
  onToggleCollapsed
}: Props) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [listTarget, setListTarget] = useState("local"); // "local" or accountId
  const [listMenu, setListMenu] = useState<{ x: number; y: number; list: TaskList } | null>(null);
  // Inline rename: the list whose name is being edited, plus the working text.
  const [editingListId, setEditingListId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");

  // Set when the user presses Escape, so the input's onBlur (which fires as the
  // field unmounts) cancels instead of saving. Without this, Esc "cancel" was
  // immediately overridden by blur-saves.
  const renameCancelRef = useRef(false);
  function submitRename(l: TaskList) {
    if (renameCancelRef.current) {
      renameCancelRef.current = false;
      setEditingListId(null);
      setEditName("");
      return;
    }
    const n = editName.trim();
    if (n && n !== l.name) onRenameList(l.id, n);
    setEditingListId(null);
    setEditName("");
  }

  /** Open the "new list" form, defaulting its destination to the first CalDAV
   *  account so new lists sync by default -- "Local only" stays a deliberate
   *  choice in the dropdown rather than the silent default. */
  function openAddList() {
    setListTarget(accounts.length > 0 ? accounts[0].id : "local");
    setName("");
    setAdding(true);
  }

  useEffect(() => {
    if (forceAdding) {
      openAddList();
      onForceAddingHandled?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forceAdding]);

  // Must come after all hooks above (Rules of Hooks) -- an early return
  // before a hook call crashes the component the moment `collapsed` flips.
  if (collapsed) {
    return (
      <div className="sidebar sidebar-collapsed">
        <button className="rail-toggle" onClick={onToggleCollapsed} title="Show Calendar/List">›</button>
      </div>
    );
  }

  const openCount = (listId: string) => tasks.filter((t) => t.list_id === listId && !t.completed && !t.parent_id).length;
  const todayCount = tasks.filter((t) => {
    if (t.completed || !t.due_date) return false;
    const due = new Date(t.due_date);
    const now = new Date();
    return due.toDateString() === now.toDateString() || due < now;
  }).length;

  async function submitNewList() {
    const trimmed = name.trim();
    const target = listTarget;
    // Close and clear the form IMMEDIATELY -- creating a server list awaits a
    // round-trip + sync (seconds), and leaving the form open + filled let an
    // impatient second click create a duplicate calendar. Reset first, then work.
    setName("");
    setListTarget("local");
    setAdding(false);
    if (trimmed) {
      if (target !== "local") {
        await onCreateServerList(trimmed, target);
      } else {
        onCreateList(trimmed);
      }
    }
  }

  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <span>Calendar/List</span>
        <button className="today-pane-collapse-btn" onClick={onToggleCollapsed} title="Hide panel">‹</button>
      </div>
      <div className="sidebar-list">
        <div className={`sidebar-item ${selectedListId === "today" ? "active" : ""}`} onClick={() => onSelect("today")}>
          <span className="sidebar-dot" style={{ background: "#e8a23d" }} />
          <span>Today &amp; Overdue</span>
          {todayCount > 0 && <span className="count">{todayCount}</span>}
        </div>
        <div className={`sidebar-item ${selectedListId === "all" ? "active" : ""}`} onClick={() => onSelect("all")}>
          <span className="sidebar-dot" style={{ background: "#888" }} />
          <span>All Tasks</span>
        </div>
        {smartFilters.length > 0 && (
          <>
            <div style={{ height: 8 }} />
            <div className="sidebar-section-label">Filters</div>
            {smartFilters.map((f) => (
              <div key={f.id} className="sidebar-item smart-filter" onClick={() => onApplyFilter?.(f)} title="Apply this saved view">
                <span className="sidebar-dot" style={{ background: "#7c6fd0" }} />
                <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{f.name}</span>
                <button
                  className="smart-filter-delete"
                  title="Delete filter"
                  onClick={(e) => { e.stopPropagation(); onDeleteFilter?.(f.id); }}
                >×</button>
              </div>
            ))}
          </>
        )}
        <div style={{ height: 8 }} />
        {lists.map((l) => (
          editingListId === l.id ? (
            <div key={l.id} className="sidebar-item" style={{ "--accent": l.color } as any}>
              <span className="sidebar-dot" style={{ background: l.color }} />
              <input
                autoFocus
                style={{ flex: 1, minWidth: 0, background: "#26272a", border: "1px solid #34353a", borderRadius: 6, color: "#fff", padding: "2px 6px" }}
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submitRename(l);
                  if (e.key === "Escape") { renameCancelRef.current = true; setEditingListId(null); setEditName(""); }
                }}
                onBlur={() => submitRename(l)}
              />
            </div>
          ) : (
            <div
              key={l.id}
              className={`sidebar-item ${selectedListId === l.id ? "active" : ""}`}
              style={{ "--accent": l.color } as any}
              onClick={() => onSelect(l.id)}
              onContextMenu={(e) => {
                e.preventDefault();
                setListMenu({ x: e.clientX, y: e.clientY, list: l });
              }}
            >
              <span className="sidebar-dot" style={{ background: l.color }} />
              <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
                {l.name}{l.caldav_calendar_url ? " ⇄" : ""}
              </span>
              {openCount(l.id) > 0 && <span className="count">{openCount(l.id)}</span>}
            </div>
          )
        ))}
        {adding ? (
          <div style={{ padding: "6px 14px" }}>
            <input
              autoFocus
              style={{ width: "100%", background: "#26272a", border: "1px solid #34353a", borderRadius: 6, color: "#fff", padding: "4px 6px" }}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitNewList();
                if (e.key === "Escape") { setAdding(false); setName(""); setListTarget("local"); }
              }}
              onBlur={accounts.length === 0 ? submitNewList : undefined}
            />
            {accounts.length > 0 && (
              <div style={{ display: "flex", gap: 4, marginTop: 4, alignItems: "center" }}>
                <select
                  style={{ flex: 1, background: "#26272a", border: "1px solid #34353a", borderRadius: 4, color: "#fff", fontSize: 11, padding: "2px 4px" }}
                  value={listTarget}
                  onChange={(e) => setListTarget(e.target.value)}
                >
                  <option value="local">Local only</option>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>On server: {a.label}</option>
                  ))}
                </select>
                <button style={{ fontSize: 11, padding: "2px 8px" }} onClick={submitNewList}>Create</button>
              </div>
            )}
          </div>
        ) : (
          <button className="sidebar-add" onClick={openAddList}>+ New list/calendar</button>
        )}
      </div>
      <div className="sidebar-footer">
        <button onClick={onSync} disabled={syncing}>{syncing ? "Syncing…" : "Sync now (Ctrl+R)"}</button>
        {syncMsg && <div style={{ fontSize: 11, color: "#9aa0a6", marginTop: 6 }}>{syncMsg}</div>}
        <div style={{ height: 6 }} />
        <button onClick={onOpenSettings}>CalDAV accounts…</button>
      </div>

      {listMenu && (
        <ContextMenu
          x={listMenu.x}
          y={listMenu.y}
          onClose={() => setListMenu(null)}
          items={[
            ...(listMenu.list.caldav_account_id
              ? [{ label: "Sync now", onClick: () => onSyncList(listMenu.list.caldav_account_id!) }]
              : []),
            ...(onSetCalendarListFilter
              ? [
                  calendarListFilter === listMenu.list.id
                    ? { label: "Show all lists in Calendar", onClick: () => onSetCalendarListFilter("all") }
                    : { label: `Show only "${listMenu.list.name}" in Calendar`, onClick: () => onSetCalendarListFilter(listMenu.list.id) }
                ]
              : []),
            {
              label: "Rename",
              onClick: () => { setEditingListId(listMenu.list.id); setEditName(listMenu.list.name); }
            },
            {
              label: "Export to .ics…",
              onClick: () => onExportList(listMenu.list.id)
            },
            // Unlink: only meaningful for a linked list -- makes it local-only,
            // keeping both the local and server copies but stopping sync.
            ...(listMenu.list.caldav_account_id
              ? [{
                  label: "Unlink",
                  danger: true,
                  onClick: () => {
                    if (confirm(`Unlink "${listMenu.list.name}"? It becomes a local-only list — its tasks stay here and on the server, but they stop syncing.`)) {
                      onRemoveList(listMenu.list.id);
                    }
                  }
                }]
              : []),
            // Delete: removes the list + its tasks here, and on the server too
            // when it's linked (App.tsx handles the server collection DELETE and
            // warns if the server refuses it).
            {
              label: "Delete",
              danger: true,
              onClick: () => {
                const msg = listMenu.list.caldav_account_id
                  ? `Delete "${listMenu.list.name}"? This removes the list and its tasks from Daynizer and from the server. This can't be undone.`
                  : `Delete "${listMenu.list.name}"? This removes the list and its tasks from Daynizer. This can't be undone.`;
                if (confirm(msg)) {
                  onDeleteList(listMenu.list.id);
                }
              }
            }
          ]}
        />
      )}
    </div>
  );
}

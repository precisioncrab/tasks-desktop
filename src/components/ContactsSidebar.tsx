import { useState, useRef } from "react";
import { Contact, AddressBook } from "../types";
import ContextMenu from "./ContextMenu";
import { ContactFilter, LabelColors, contactLabels } from "../contactUtils";

const PALETTE: { name: string; color: string }[] = [
  { name: "Blue", color: "#4a90d9" },
  { name: "Red", color: "#e5484d" },
  { name: "Amber", color: "#e8a23d" },
  { name: "Green", color: "#3fb950" },
  { name: "Purple", color: "#a371f7" },
  { name: "Pink", color: "#db61a2" },
  { name: "Gray", color: "#6f7378" }
];

interface Props {
  addressBooks: AddressBook[];
  contacts: Contact[];
  accounts: { id: string; label: string }[];
  filter: ContactFilter;
  onSelect: (f: ContactFilter) => void;
  onCreateBook: (name: string) => void;
  onCreateServerBook: (name: string, accountId: string) => Promise<void>;
  onRenameBook: (id: string, name: string) => void;
  labelColors: LabelColors;
  onSetLabelColor: (label: string, color: string | null) => void;
  onDeleteLabel: (label: string) => void;
  onDisconnectBook: (b: AddressBook) => void;
  onDeleteBook: (b: AddressBook) => void;
  onSync: () => void;
  syncing: boolean;
  onOpenSettings: () => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}

export default function ContactsSidebar({
  addressBooks, contacts, accounts, filter, onSelect, onCreateBook, onCreateServerBook, onRenameBook, labelColors, onSetLabelColor, onDeleteLabel,
  onDisconnectBook, onDeleteBook, onSync, syncing, onOpenSettings, collapsed, onToggleCollapsed
}: Props) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [bookTarget, setBookTarget] = useState("local"); // "local" or accountId
  const [labelMenu, setLabelMenu] = useState<{ x: number; y: number; label: string } | null>(null);
  const [bookMenu, setBookMenu] = useState<{ x: number; y: number; book: AddressBook } | null>(null);
  // Inline rename of an address book, mirroring the Calendar/List sidebar.
  const [editingBookId, setEditingBookId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const renameCancelRef = useRef(false);
  function submitRename(b: AddressBook) {
    if (renameCancelRef.current) { renameCancelRef.current = false; setEditingBookId(null); setEditName(""); return; }
    const n = editName.trim();
    if (n && n !== b.name) onRenameBook(b.id, n);
    setEditingBookId(null); setEditName("");
  }

  /** Open the "new address book" form, defaulting its destination to the first
   *  account so new books sync by default -- "Local only" stays a deliberate
   *  choice in the dropdown, mirroring the Calendar/List sidebar. */
  function openAddBook() {
    setBookTarget(accounts.length > 0 ? accounts[0].id : "local");
    setName("");
    setAdding(true);
  }

  if (collapsed) {
    return (
      <div className="sidebar sidebar-collapsed">
        <button className="rail-toggle" onClick={onToggleCollapsed} title="Show Contacts">›</button>
      </div>
    );
  }

  const active = (f: ContactFilter) => JSON.stringify(f) === JSON.stringify(filter);
  const live = contacts.filter((c) => !c.deleted);
  const bookCount = (id: string) => live.filter((c) => c.address_book_id === id).length;
  const labels = (() => {
    const set = new Set<string>();
    for (const c of live) for (const l of contactLabels(c)) set.add(l);
    return [...set].sort((a, b) => a.localeCompare(b));
  })();

  async function submitNewBook() {
    const trimmed = name.trim();
    const target = bookTarget;
    // Close + clear immediately (creating a server book awaits a round-trip);
    // reset first, then work -- mirrors the Calendar/List sidebar.
    setName(""); setBookTarget("local"); setAdding(false);
    if (trimmed) {
      if (target !== "local") await onCreateServerBook(trimmed, target);
      else onCreateBook(trimmed);
    }
  }

  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <span>Contacts</span>
        <button className="today-pane-collapse-btn" onClick={onToggleCollapsed} title="Hide panel">‹</button>
      </div>
      <div className="sidebar-list">
        <div className={`sidebar-item ${active({ kind: "all" }) ? "active" : ""}`} onClick={() => onSelect({ kind: "all" })}>
          <span className="sidebar-dot" style={{ background: "#888" }} />
          <span style={{ flex: 1 }}>All contacts</span>
          {live.length > 0 && <span className="count">{live.length}</span>}
        </div>

        <div style={{ height: 8 }} />
        <div className="sidebar-section-label">Address books</div>
        {addressBooks.map((b) => (
          editingBookId === b.id ? (
            <div key={b.id} className="sidebar-item" style={{ "--accent": b.color } as any}>
              <span className="sidebar-dot" style={{ background: b.color }} />
              <input
                autoFocus
                style={{ flex: 1, minWidth: 0, background: "#26272a", border: "1px solid #34353a", borderRadius: 6, color: "#fff", padding: "2px 6px" }}
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submitRename(b);
                  if (e.key === "Escape") { renameCancelRef.current = true; setEditingBookId(null); setEditName(""); }
                }}
                onBlur={() => submitRename(b)}
              />
            </div>
          ) : (
            <div
              key={b.id}
              className={`sidebar-item ${active({ kind: "book", value: b.id }) ? "active" : ""}`}
              style={{ "--accent": b.color } as any}
              onClick={() => onSelect({ kind: "book", value: b.id })}
              onContextMenu={(e) => { e.preventDefault(); setBookMenu({ x: e.clientX, y: e.clientY, book: b }); }}
              title={b.carddav_addressbook_url ? "Right-click to rename, disconnect or delete" : "Right-click to rename or delete"}
            >
              <span className="sidebar-dot" style={{ background: b.color }} />
              <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
                {b.name}{b.carddav_addressbook_url ? " ⇄" : ""}
              </span>
              {bookCount(b.id) > 0 && <span className="count">{bookCount(b.id)}</span>}
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
              onKeyDown={(e) => { if (e.key === "Enter") submitNewBook(); if (e.key === "Escape") { setAdding(false); setName(""); setBookTarget("local"); } }}
              onBlur={accounts.length === 0 ? submitNewBook : undefined}
            />
            {accounts.length > 0 && (
              <div style={{ display: "flex", gap: 4, marginTop: 4, alignItems: "center" }}>
                <select
                  style={{ flex: 1, background: "#26272a", border: "1px solid #34353a", borderRadius: 4, color: "#fff", fontSize: 11, padding: "2px 4px" }}
                  value={bookTarget}
                  onChange={(e) => setBookTarget(e.target.value)}
                >
                  <option value="local">Local only</option>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>On server: {a.label}</option>
                  ))}
                </select>
                <button style={{ fontSize: 11, padding: "2px 8px" }} onClick={submitNewBook}>Create</button>
              </div>
            )}
          </div>
        ) : (
          <button className="sidebar-add" onClick={openAddBook}>+ New address book</button>
        )}

        {labels.length > 0 && (
          <>
            <div style={{ height: 8 }} />
            <div className="sidebar-section-label">Labels</div>
            {labels.map((l) => (
              <div
                key={l}
                className={`sidebar-item ${active({ kind: "label", value: l }) ? "active" : ""}`}
                onClick={() => onSelect({ kind: "label", value: l })}
                onContextMenu={(e) => { e.preventDefault(); setLabelMenu({ x: e.clientX, y: e.clientY, label: l }); }}
                title="Right-click to set a color"
              >
                <span className="sidebar-dot" style={{ background: labelColors[l] || "#6f7378" }} />
                <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{l}</span>
              </div>
            ))}
          </>
        )}
      </div>
      <div className="sidebar-footer">
        <button onClick={onSync} disabled={syncing}>{syncing ? "Syncing…" : "Sync now (Ctrl+R)"}</button>
        <div style={{ height: 6 }} />
        <button onClick={onOpenSettings}>CardDAV accounts…</button>
      </div>

      {labelMenu && (
        <ContextMenu
          x={labelMenu.x}
          y={labelMenu.y}
          onClose={() => setLabelMenu(null)}
          items={[
            ...PALETTE.map((p) => ({ label: `● ${p.name}`, onClick: () => onSetLabelColor(labelMenu.label, p.color) })),
            { label: "No color", onClick: () => onSetLabelColor(labelMenu.label, null) },
            { label: "Delete label", danger: true, onClick: () => onDeleteLabel(labelMenu.label) }
          ]}
        />
      )}

      {bookMenu && (
        <ContextMenu
          x={bookMenu.x}
          y={bookMenu.y}
          onClose={() => setBookMenu(null)}
          items={[
            { label: "Rename", onClick: () => { setEditingBookId(bookMenu.book.id); setEditName(bookMenu.book.name); } },
            ...(bookMenu.book.carddav_addressbook_url
              ? [{ label: "Disconnect from CardDAV", onClick: () => onDisconnectBook(bookMenu.book) }]
              : []),
            { label: "Delete address book", danger: true, onClick: () => onDeleteBook(bookMenu.book) }
          ]}
        />
      )}
    </div>
  );
}

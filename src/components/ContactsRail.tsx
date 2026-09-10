import { Contact } from "../types";
import { formatRelativeDays, formatShortDate } from "../dateFormat";

interface Props {
  contacts: Contact[];
  onSelectContact: (id: string) => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}

interface Upcoming {
  contactId: string;
  name: string;
  kind: "birthday" | "anniversary";
  date: Date;
  daysUntil: number;
  turning: number | null; // age/years on the next occurrence, or null if year unknown
}

/** Pull month/day (and year if present) out of a bday/anniversary string.
 *  Handles "YYYY-MM-DD", "YYYYMMDD", "--MM-DD"/"--MMDD" (year-less), with or
 *  without a trailing time. */
function parseDateParts(s: string): { month: number; day: number; year: number | null } | null {
  if (!s) return null;
  const str = s.trim();
  let m = str.match(/^--(\d{2})-?(\d{2})$/);
  if (m) return { month: +m[1], day: +m[2], year: null };
  m = str.match(/^(\d{4})-?(\d{2})-?(\d{2})/);
  if (m) { const y = +m[1]; return { month: +m[2], day: +m[3], year: y > 1000 ? y : null }; }
  return null;
}

function nextOccurrence(month: number, day: number, from: Date) {
  const today = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  let d = new Date(today.getFullYear(), month - 1, day);
  if (d.getTime() < today.getTime()) d = new Date(today.getFullYear() + 1, month - 1, day);
  const daysUntil = Math.round((d.getTime() - today.getTime()) / 86400000);
  return { date: d, daysUntil };
}

/** "today" / "tomorrow" / "in 5 days", localized. `Intl.RelativeTimeFormat`
 *  with `numeric: "auto"` produces exactly these three shapes itself. */
function whenLabel(n: number): string {
  return formatRelativeDays(Math.max(0, n));
}

export default function ContactsRail({ contacts, onSelectContact, collapsed, onToggleCollapsed }: Props) {
  if (collapsed) {
    return (
      <div className="today-pane today-pane-collapsed">
        <button className="rail-toggle" onClick={onToggleCollapsed} title="Show upcoming birthdays">‹</button>
      </div>
    );
  }

  const now = new Date();
  const items: Upcoming[] = [];
  for (const c of contacts) {
    if (c.deleted) continue;
    const name = c.fn || "Unnamed";
    for (const kind of ["birthday", "anniversary"] as const) {
      const raw = kind === "birthday" ? c.bday : c.anniversary;
      const parts = parseDateParts(raw || "");
      if (!parts) continue;
      const { date, daysUntil } = nextOccurrence(parts.month, parts.day, now);
      const turning = parts.year != null ? date.getFullYear() - parts.year : null;
      items.push({ contactId: c.id, name, kind, date, daysUntil, turning });
    }
  }
  items.sort((a, b) => a.daysUntil - b.daysUntil);
  const top = items.slice(0, 8);

  return (
    <div className="today-pane">
      <div className="today-pane-header">
        <div className="today-pane-title-row">
          <h3>Upcoming</h3>
          <button className="today-pane-collapse-btn" onClick={onToggleCollapsed} title="Hide panel">›</button>
        </div>
      </div>
      {top.length === 0 && <p className="today-pane-empty">No upcoming birthdays or anniversaries.</p>}
      <ul className="today-pane-list">
        {top.map((u, i) => (
          <li key={`${u.contactId}-${u.kind}-${i}`} onClick={() => onSelectContact(u.contactId)}>
            <span style={{ flexShrink: 0 }}>{u.kind === "birthday" ? "🎂" : "💍"}</span>
            <span className="today-pane-title">
              {u.name}
              <span style={{ color: "#8a8d93" }}>
                {" · "}{formatShortDate(u.date)}
                {u.turning != null ? ` · turns ${u.turning}` : ""}
              </span>
            </span>
            <span className="today-pane-label">{whenLabel(u.daysUntil)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

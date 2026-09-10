/** Locale-aware date/time helpers, in one place so every view agrees on what
 *  "the current locale" is.
 *
 *  Call sites historically passed `undefined` as the locale to `toLocale*` and
 *  let each one resolve the engine default independently. `appLocale()` is
 *  seeded from that same default, so behavior is unchanged -- but there is now
 *  a single place to override it later instead of a dozen. */

/** The engine's resolved default locale ("de-AT", "en-US", ...). Cached: it
 *  can't change without an app restart, and `Intl` resolution isn't free. */
let cachedLocale: string | null = null;

export function appLocale(): string {
  if (cachedLocale === null) cachedLocale = new Intl.DateTimeFormat().resolvedOptions().locale;
  return cachedLocale;
}

/** Regions whose week does NOT start on Monday, keyed by the first day in
 *  `Date#getDay` numbering. Generated from ICU's own CLDR tables (ICU 78.2 /
 *  CLDR 48) rather than typed by hand -- an earlier hand-copied list had CN,
 *  AE, IS and MV wrong, since CLDR revises these as countries change their
 *  working week.
 *
 *  Consulted only when the engine has no `Intl.Locale#getWeekInfo`: Electron's
 *  Chromium has it, but `src/**` is shared with the Thunderbird add-on, whose
 *  Gecko may not. Anything unlisted starts on Monday -- ISO-8601, and correct
 *  for all of Europe, which is exactly what the library's unconditional
 *  `firstDay: 0` got wrong. */
const NON_MONDAY_REGIONS: Record<number, string> = {
  0: "AG AS BD BR BS BT BW BZ CA CO DM DO ET GT GU HK HN ID IL IN IS JM JP KE KH KR LA MH " +
     "MM MO MT MX MZ NI NP PA PE PH PK PR PT PY SA SG SV TH TT TW UM US VE VI WS YE ZA ZW",
  5: "MV",
  6: "AF BH DJ DZ EG IQ IR JO KW LY OM QA SD SY"
};
const FALLBACK_FIRST_DAY = new Map<string, number>(
  Object.entries(NON_MONDAY_REGIONS).flatMap(([day, regions]) =>
    regions.split(" ").map((r) => [r, Number(day)] as [string, number])
  )
);

/** First day of the week for the app's locale, numbered the way
 *  @event-calendar/core's `firstDay` (and `Date#getDay`) expect it:
 *  0 = Sunday, 1 = Monday, ... 6 = Saturday. */
export function firstDayOfWeek(): number {
  let locale: Intl.Locale;
  // `maximize()` fills in the region a bare tag omits, so "ja" resolves via
  // "ja-JP" rather than falling through to the Monday default.
  try { locale = new Intl.Locale(appLocale()).maximize(); } catch { return 1; }

  // Preferred path: real CLDR data from the engine. `getWeekInfo()` is the
  // spec'd method; some engines shipped only the earlier `weekInfo` getter.
  // Neither is in TypeScript's `Intl.Locale` yet, hence the casts.
  const info = (locale as any).getWeekInfo?.() ?? (locale as any).weekInfo;
  // CLDR numbers days 1 = Monday .. 7 = Sunday; `% 7` maps that onto 0 = Sunday.
  if (typeof info?.firstDay === "number") return info.firstDay % 7;

  const region = locale.region;
  if (!region) return 1;
  // `?? 1` and not `|| 1`: Sunday is 0, which `||` would throw away.
  return FALLBACK_FIRST_DAY.get(region) ?? 1;
}

// ---------- Parsing stored values ----------

/** True for the "YYYY-MM-DD" all-day form, false for a full ISO datetime.
 *  Same length test the rest of the codebase uses to tell the two apart. */
export function isDateOnly(value: string): boolean {
  return value.length <= 10;
}

/** Turn a stored date/datetime into a `Date` positioned in LOCAL time.
 *
 *  `new Date("2026-03-15")` is specified to parse as UTC midnight, which every
 *  zone west of UTC then renders as the 14th -- so an all-day task due today
 *  showed yesterday's date and, because the shifted value also failed the
 *  same-day test, was styled overdue. All-day values are therefore split and
 *  rebuilt from their parts. Noon, not midnight, so a DST jump at 00:00 can't
 *  push the date onto the previous day -- the same trick CalendarView already
 *  uses when it reads a stored date back. */
export function parseStored(value: Date | string | null | undefined): Date | null {
  if (value == null || value === "") return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (isDateOnly(value)) {
    const [y, m, d] = value.split("-").map(Number);
    if (!y || !m || !d) return null;
    return new Date(y, m - 1, d, 12);
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

// ---------- Display formatting ----------

/** `Intl` formatters are costly to construct and the task table would build a
 *  fresh one per row, so they're memoized per option set. */
const formatters = new Map<string, Intl.DateTimeFormat>();

function dateTimeFormat(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = JSON.stringify(options);
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(appLocale(), options);
    formatters.set(key, f);
  }
  return f;
}

/** Day and month without a year, ordered per locale: "Mar 3", "3. März", "3月3日". */
export function formatShortDate(value: Date | string | null | undefined): string {
  const d = parseStored(value);
  return d ? dateTimeFormat({ month: "short", day: "numeric" }).format(d) : "";
}

/** Time of day, 12- or 24-hour according to the locale: "2:30 PM", "14:30". */
export function formatTime(value: Date | string | null | undefined): string {
  const d = parseStored(value);
  return d ? dateTimeFormat({ hour: "numeric", minute: "2-digit" }).format(d) : "";
}

/** Full date and time. The explicit options reproduce what a bare
 *  `Date#toLocaleString()` produces -- `Intl.DateTimeFormat` with no options
 *  would drop the time entirely. */
export function formatDateTime(value: Date | string | null | undefined): string {
  const d = parseStored(value);
  if (!d) return "";
  return dateTimeFormat({
    year: "numeric", month: "numeric", day: "numeric",
    hour: "numeric", minute: "numeric", second: "numeric"
  }).format(d);
}

let relativeFormatter: Intl.RelativeTimeFormat | null = null;

/** A whole-day offset as words: "today", "tomorrow", "in 5 days", "yesterday".
 *  `numeric: "auto"` is what turns 0 and 1 into words instead of "in 0 days". */
export function formatRelativeDays(days: number): string {
  if (relativeFormatter === null) {
    relativeFormatter = new Intl.RelativeTimeFormat(appLocale(), { numeric: "auto" });
  }
  return relativeFormatter.format(days, "day");
}

/** Upper-case the first character, for a phrase used as a standalone label.
 *  Locale-aware, so Turkish gets "İ" rather than "I"; iterates by code point
 *  so an astral first character survives. */
export function capitalizeFirst(text: string): string {
  if (!text) return text;
  const [first, ...rest] = [...text];
  return first.toLocaleUpperCase(appLocale()) + rest.join("");
}

/** True when two instants fall on the same local calendar day. */
export function isSameLocalDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

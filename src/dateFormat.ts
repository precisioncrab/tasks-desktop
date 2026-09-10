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

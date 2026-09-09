export interface TaskList {
  id: string;
  name: string;
  color: string;
  sort_order: number;
  caldav_account_id: string | null;
  caldav_calendar_url: string | null;
  caldav_ctag: string | null;
  created_at: string;
  updated_at: string;
}

export interface Task {
  id: string;
  list_id: string;
  parent_id: string | null;
  title: string;
  notes: string;
  due_date: string | null;
  start_date: string | null;
  priority: 0 | 1 | 5 | 9;
  completed: 0 | 1;
  completed_at: string | null;
  recurrence: string | null;
  tags: string;
  sort_order: number;
  caldav_uid: string | null;
  caldav_href: string | null;
  caldav_etag: string | null;
  deleted: 0 | 1;
  dirty?: 0 | 1;
  created_at: string;
  updated_at: string;
}

export interface CalendarEvent {
  id: string;
  list_id: string;
  title: string;
  notes: string;
  location: string;
  start_date: string;
  end_date: string | null;
  all_day: 0 | 1;
  recurrence: string | null;
  /** JSON array of removed occurrence-start strings (EXDATE). */
  exdates?: string;
  /** JSON array of EventOverride objects (per-occurrence edits). */
  overrides?: string;
  tags: string;
  caldav_uid: string | null;
  caldav_href: string | null;
  caldav_etag: string | null;
  deleted: 0 | 1;
  dirty?: 0 | 1;
  created_at: string;
  updated_at: string;
}

/** A single-occurrence override of a recurring event, keyed by the original
 *  occurrence start it replaces (its RECURRENCE-ID). Mirrors electron/ical.ts. */
export interface EventOverride {
  recurrence_id: string;
  title?: string;
  notes?: string;
  location?: string;
  start_date: string;
  end_date: string | null;
  all_day: 0 | 1;
}

export interface Reminder {
  id: string;
  owner_type: "task" | "event";
  owner_id: string;
  /** 0 = at time of due/start; >0 = minutes before. */
  offset_minutes: number;
  fired_at: string | null;
  created_at: string;
}

export interface CaldavAccountPublic {
  id: string;
  label: string;
  server_url: string;
  carddav_url: string | null;
  username: string;
  principal_url: string | null;
  last_sync_at: string | null;
  last_sync_status: string | null;
  created_at: string;
}

export interface DiscoveredCalendar {
  url: string;
  displayName: string;
  ctag: string | null;
  supportsTodo: boolean;
  color: string | null;
}

export interface AddressBook {
  id: string;
  name: string;
  color: string;
  sort_order: number;
  carddav_account_id: string | null;
  carddav_addressbook_url: string | null;
  carddav_ctag: string | null;
  created_at: string;
  updated_at: string;
}

export interface TypedValue { type: string; value: string; }
export interface PostalAddress {
  type: string;
  street: string;
  city: string;
  region: string;
  postal: string;
  country: string;
}

/** A contact row. The multi-value fields (phones/emails/addresses/urls/impps/
 *  related) are JSON-text as stored in the DB -- parse before use. */
export interface Contact {
  id: string;
  address_book_id: string;
  fn: string;
  prefix: string;
  first_name: string;
  middle_name: string;
  last_name: string;
  suffix: string;
  nickname: string;
  org: string;
  title: string;
  bday: string | null;
  anniversary: string | null;
  notes: string;
  categories: string;
  photo: string;
  phones: string;
  emails: string;
  addresses: string;
  urls: string;
  impps: string;
  related: string;
  raw_vcard: string;
  carddav_uid: string | null;
  carddav_href: string | null;
  carddav_etag: string | null;
  deleted: 0 | 1;
  dirty?: 0 | 1;
  sequence: number;
  created_at: string;
  updated_at: string;
  /** Labels inherited from CardDAV group cards (Synology labels), decorated by
   *  the main process; merged with this contact's own CATEGORIES for display. */
  group_labels?: string;
}

export interface DiscoveredAddressBook {
  url: string;
  displayName: string;
  ctag: string | null;
}

export const PRIORITY_LABELS: Record<number, string> = {
  0: "None",
  1: "High",
  5: "Medium",
  9: "Low"
};

export const PRIORITY_COLORS: Record<number, string> = {
  0: "#6b7280",
  1: "#e5484d",
  5: "#e8a23d",
  9: "#4a90d9"
};

declare global {
  interface Window {
    api: {
      /** Absent in the Thunderbird add-on shim -- always optional-chain. */
      app?: {
        version: () => Promise<string>;
        installUpdate: () => Promise<void>;
      };
      /** Absent in the Thunderbird add-on shim -- always optional-chain. */
      settings?: {
        all: () => Promise<Record<string, string>>;
        set: (key: string, value: string) => Promise<void>;
      };
      lists: {
        all: () => Promise<TaskList[]>;
        create: (name: string, color?: string) => Promise<TaskList>;
        update: (id: string, patch: Partial<TaskList>) => Promise<TaskList>;
        delete: (id: string) => Promise<void>;
        export: (id: string) => Promise<{ ok: boolean; canceled?: boolean; count?: number; path?: string }>;
      };
      tasks: {
        all: () => Promise<Task[]>;
        byList: (listId: string) => Promise<Task[]>;
        subtasks: (parentId: string) => Promise<Task[]>;
        create: (input: Partial<Task> & { list_id: string; title: string }) => Promise<Task>;
        update: (id: string, patch: Partial<Task>) => Promise<Task>;
        toggleComplete: (id: string) => Promise<Task>;
        delete: (id: string, hard?: boolean) => Promise<void>;
      };
      /** Absent in the Thunderbird add-on shim -- always optional-chain. */
      events?: {
        all: () => Promise<CalendarEvent[]>;
        create: (input: Partial<CalendarEvent> & { list_id: string; title: string; start_date: string }) => Promise<CalendarEvent>;
        update: (id: string, patch: Partial<CalendarEvent>) => Promise<CalendarEvent>;
        delete: (id: string, hard?: boolean) => Promise<void>;
      };
      /** Absent in the Thunderbird add-on shim -- always optional-chain. */
      addressbooks?: {
        all: () => Promise<AddressBook[]>;
        create: (name: string, color?: string) => Promise<AddressBook>;
        update: (id: string, patch: Partial<AddressBook>) => Promise<AddressBook>;
        delete: (id: string) => Promise<void>;
        discover: (accountId: string) => Promise<DiscoveredAddressBook[]>;
        link: (bookId: string, accountId: string, url: string) => Promise<void>;
        connect: (accountId: string, url: string, displayName: string) => Promise<AddressBook>;
        unlink: (bookId: string) => Promise<void>;
        /** Create a new address book ON THE SERVER (MKCOL) + link a local book.
         *  Absent in the add-on shim -- optional-chain. */
        createServer?: (accountId: string, name: string) => Promise<AddressBook>;
      };
      /** Absent in the Thunderbird add-on shim -- always optional-chain. */
      maintenance?: {
        dedupe: (dryRun?: boolean) => Promise<{
          listsMerged: number; listsRenamedLocal: number;
          booksMerged: number; booksRenamedLocal: number;
          contactsRemoved: number; details: string[];
        }>;
      };
      /** Absent in the Thunderbird add-on shim -- always optional-chain. */
      contacts?: {
        all: () => Promise<Contact[]>;
        byBook: (bookId: string) => Promise<Contact[]>;
        create: (input: Partial<Contact> & { address_book_id: string }) => Promise<Contact>;
        update: (id: string, patch: Partial<Contact>) => Promise<Contact>;
        delete: (id: string, hard?: boolean) => Promise<void>;
        import: (opts: { label: string; bookId: string; createNew: boolean }) => Promise<{
          canceled?: boolean; total?: number; labeled?: number; matched?: number; created?: number; skipped?: number;
        }>;
        merge: (keeperId: string, loserIds: string[], patch: Partial<Contact>) => Promise<Contact>;
      };
      /** Absent in the Thunderbird add-on shim -- always optional-chain. */
      reminders?: {
        for: (ownerType: "task" | "event", ownerId: string) => Promise<Reminder[]>;
        create: (ownerType: "task" | "event", ownerId: string, offsetMinutes: number) => Promise<Reminder>;
        delete: (id: string) => Promise<void>;
      };
      accounts: {
        all: () => Promise<CaldavAccountPublic[]>;
        // No-op (always true) under Electron, which has no CORS/permission
        // model to satisfy. Under the Thunderbird add-on, requests the
        // optional host permission for this server's origin -- must be
        // called from a click handler (user gesture), which is why it's a
        // separate call the UI makes before testConnection/create/sync,
        // not something bundled invisibly into those.
        ensureHostPermission: (serverUrls: string | string[]) => Promise<boolean>;
        create: (input: { label: string; server_url: string; username: string; password: string }) => Promise<CaldavAccountPublic>;
        update: (id: string, patch: any) => Promise<CaldavAccountPublic>;
        delete: (id: string) => Promise<void>;
        testConnection: (account: any) => Promise<{ ok: boolean; message: string }>;
        discoverCalendars: (accountId: string) => Promise<DiscoveredCalendar[]>;
        linkList: (listId: string, accountId: string, calendarUrl: string) => Promise<void>;
        connectCalendar: (accountId: string, calendarUrl: string, displayName: string, color?: string | null) => Promise<TaskList>;
        unlinkList: (listId: string) => Promise<void>;
        sync: (accountId: string) => Promise<{ listId: string; pulled: number; pushed: number; errors: string[] }[]>;
        createServerCalendar: (accountId: string, name: string) => Promise<TaskList>;
        deleteServerCalendar: (accountId: string, calendarUrl: string) => Promise<void>;
        /** Auto-create default collections (Calendar / Contacts) on a server
         *  that has none yet. No-op where collections already exist. Absent in
         *  the add-on shim -- optional-chain. */
        bootstrapDefaults?: (accountId: string) => Promise<{ calendar?: string; addressBook?: string }>;
      };
      on: (channel: string, callback: (...args: any[]) => void) => () => void;
    };
  }
}

import { createDAVClient } from "tsdav";

type Client = Awaited<ReturnType<typeof createDAVClient>>;
import {
  CaldavAccount,
  AddressBook,
  Contact,
  addressBooksAll,
  addressBookCreate,
  addressBookUpdate,
  davUrlKey,
  contactsAll,
  contactsByBook,
  contactsByBookWithUid,
  contactCreate,
  contactUpdate,
  contactDelete,
  contactsPruneMissing,
  contactGroupUpsert,
  contactGroupsPruneMissing,
  accountExists,
  getDb
} from "./db.js";
import { parseVCard, parseGroupCard, contactToVCard, displayName, ParsedContact } from "./vcard.js";
// Reuse the CalDAV account plumbing: same server credentials + logging.
import { decryptPassword, syncLog } from "./caldav.js";

/** Compare two object URLs by path only (servers report absolute or relative). */
function samePath(a: string, b: string): boolean {
  const p = (u: string) => { try { return new URL(u, "http://x").pathname; } catch { return u; } };
  return p(a) === p(b);
}

async function clientFor(account: CaldavAccount): Promise<Client> {
  return createDAVClient({
    // CardDAV lives at a different address than CalDAV on some servers (e.g.
    // Synology), so prefer the account's dedicated carddav_url when set.
    serverUrl: account.carddav_url || account.server_url,
    credentials: {
      username: account.username,
      password: decryptPassword(account.password_enc)
    },
    authMethod: "Basic",
    defaultAccountType: "carddav"
  });
}

export interface DiscoveredAddressBook {
  url: string;
  displayName: string;
  ctag: string | null;
}

export async function discoverAddressBooks(account: CaldavAccount): Promise<DiscoveredAddressBook[]> {
  try {
    const client = await clientFor(account);
    const books = await client.fetchAddressBooks();
    return books.map((b) => ({
      url: String(b.url),
      displayName: String((b as any).displayName || b.url),
      ctag: (b as any).ctag ?? null
    }));
  } catch (err: any) {
    // Node/undici wraps the real reason (TLS, ECONNREFUSED, 404, ...) in
    // `err.cause`; surface it so "fetch failed" becomes diagnosable.
    const cause = err?.cause?.message || err?.cause?.code || (err?.cause ? String(err.cause) : "");
    syncLog(`carddav discover FAILED for ${account.carddav_url || account.server_url}: ${err?.message}${cause ? ` (cause: ${cause})` : ""}`);
    console.error("carddav discover error:", err, "\ncause:", err?.cause);
    throw new Error(cause ? `${err?.message || "discover failed"} — ${cause}` : (err?.message || String(err)));
  }
}

/** Link a local address book to a discovered remote one (unlinking any other
 *  local book pointing at the same remote first), mirroring linkListToCalendar. */
export function linkAddressBook(bookId: string, accountId: string, url: string) {
  // Refuse a dead account id. The renderer can hand us one from a stale
  // accounts array; persisting it detaches the book from sync silently (the
  // hasBooks gate just skips it), which hid a broken contact sync for days.
  if (!accountExists(accountId)) {
    throw new Error(`Cannot link address book: account ${accountId} no longer exists. Reopen Settings and try again.`);
  }
  // Normalized-key match (see davUrlKey) so an http<->https change on the same
  // address book is recognized instead of orphaning the old book.
  const key = davUrlKey(url);
  for (const b of addressBooksAll()) {
    if (b.carddav_account_id === accountId && davUrlKey(b.carddav_addressbook_url) === key && b.id !== bookId) {
      addressBookUpdate(b.id, { carddav_account_id: null, carddav_addressbook_url: null, carddav_ctag: null } as Partial<AddressBook>);
    }
  }
  addressBookUpdate(bookId, { carddav_account_id: accountId, carddav_addressbook_url: url, carddav_ctag: null } as Partial<AddressBook>);
}

/** Find an address book already linked to this remote book for the account,
 *  matching by normalized URL. */
export function bookFindByUrl(accountId: string, url: string): AddressBook | undefined {
  const key = davUrlKey(url);
  return addressBooksAll().find(
    (b) => b.carddav_account_id === accountId && davUrlKey(b.carddav_addressbook_url) === key
  );
}

/** Idempotent connect for the Settings UI -- reuses an existing linked book
 *  (matched by normalized URL) instead of creating a duplicate. Prevents the
 *  duplicate-address-book bug that produces triplicate contacts. */
export function connectAddressBook(accountId: string, url: string, displayName: string): AddressBook {
  const existing = bookFindByUrl(accountId, url);
  if (existing) {
    return addressBookUpdate(existing.id, { carddav_addressbook_url: url } as Partial<AddressBook>);
  }
  const book = addressBookCreate(displayName);
  linkAddressBook(book.id, accountId, url);
  return addressBooksAll().find((b) => b.id === book.id)!;
}

export function unlinkAddressBook(bookId: string) {
  addressBookUpdate(bookId, { carddav_account_id: null, carddav_addressbook_url: null, carddav_ctag: null } as Partial<AddressBook>);
}

/** Push a renamed address book's title to the server as the collection's
 *  DAV:displayname via PROPPATCH, so a rename in the app propagates to the
 *  server (Radicale / Nextcloud / Synology) instead of staying local. Mirrors
 *  caldav.ts's pushCalendarName. Best-effort: throws on failure so the caller
 *  can log it while keeping the local rename. */
export async function pushAddressBookName(account: CaldavAccount, addressBookUrl: string, name: string): Promise<void> {
  const client = await clientFor(account);
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const body =
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<d:propertyupdate xmlns:d="DAV:"><d:set><d:prop>` +
    `<d:displayname>${esc(name)}</d:displayname>` +
    `</d:prop></d:set></d:propertyupdate>`;
  const res = await client.davRequest({
    url: addressBookUrl,
    init: {
      method: "PROPPATCH",
      headers: { "content-type": "application/xml; charset=utf-8" },
      body
    },
    convertIncoming: false,
    parseOutgoing: false
  });
  const ok = !Array.isArray(res) || res.every((r) => r.ok !== false && (r.status ? r.status < 400 : true));
  syncLog(`PROPPATCH displayname (addressbook) ${addressBookUrl} -> "${name}": ${ok ? "ok" : JSON.stringify(res)}`);
  if (!ok) throw new Error(`Server rejected address book displayname change (${JSON.stringify(res)})`);
}

/** Create a new address book collection ON THE SERVER, then create + link a
 *  local book to it. The CardDAV twin of caldav.ts's createServerCalendar:
 *  it resolves the addressbook-home from the principal (so it works even when
 *  the server has ZERO address books, e.g. a fresh Radicale user), and only
 *  falls back to deriving the home from an existing book. tsdav has no
 *  makeAddressBook helper, so the MKCOL is issued directly (mirroring how
 *  makeCalendar issues MKCALENDAR), declaring an addressbook resourcetype. */
export async function createServerAddressBook(account: CaldavAccount, name: string): Promise<AddressBook> {
  const client = await clientFor(account);

  let homeUrl = "";
  try {
    const acct = await client.createAccount({
      account: { serverUrl: account.carddav_url || account.server_url, accountType: "carddav" },
      loadCollections: false,
      loadObjects: false
    });
    if (acct?.homeUrl) homeUrl = String(acct.homeUrl).replace(/\/?$/, "/");
  } catch {
    /* discovery failed -- fall back to the existing-book derivation below */
  }

  if (!homeUrl) {
    const books = await client.fetchAddressBooks();
    if (books.length === 0) {
      throw new Error(
        "Could not determine where to create the address book: the server advertised no addressbook-home-set and has no existing address books to derive it from."
      );
    }
    const existingUrl = String(books[0].url).replace(/\/?$/, "/");
    homeUrl = existingUrl.replace(/[^/]+\/$/, "");
  }

  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "contacts";
  const newBookUrl = `${homeUrl}${slug}-${Date.now()}/`;

  // MKCOL with an addressbook resourcetype. The DAV: (d) and CardDAV (card)
  // namespaces are declared on the <mkcol> element so <card:addressbook> is valid.
  const res = await client.davRequest({
    url: newBookUrl,
    init: {
      method: "MKCOL",
      namespace: "d",
      body: {
        "d:mkcol": {
          _attributes: {
            "xmlns:d": "DAV:",
            "xmlns:card": "urn:ietf:params:xml:ns:carddav"
          },
          "d:set": {
            "d:prop": {
              "d:resourcetype": {
                "d:collection": {},
                "card:addressbook": {}
              },
              "d:displayname": name
            }
          }
        }
      }
    }
  });
  const r = res?.[0];
  if (r && r.ok === false) {
    throw new Error(`Server refused to create the address book (${r.status}${r.statusText ? ` ${r.statusText}` : ""}).`);
  }

  const book = addressBookCreate(name);
  linkAddressBook(book.id, account.id, newBookUrl);
  return addressBooksAll().find((b) => b.id === book.id)!;
}

// ---------- Contact <-> vCard row mapping ----------
function jsonArr(s: string): any[] {
  try { const v = JSON.parse(s || "[]"); return Array.isArray(v) ? v : []; } catch { return []; }
}

function contactToParsed(c: Contact): ParsedContact {
  return {
    uid: c.carddav_uid,
    fn: c.fn, prefix: c.prefix, first_name: c.first_name, middle_name: c.middle_name,
    last_name: c.last_name, suffix: c.suffix, nickname: c.nickname, org: c.org, title: c.title,
    bday: c.bday, anniversary: c.anniversary, notes: c.notes, categories: c.categories, photo: c.photo,
    phones: jsonArr(c.phones), emails: jsonArr(c.emails), addresses: jsonArr(c.addresses),
    urls: jsonArr(c.urls), impps: jsonArr(c.impps), related: jsonArr(c.related)
  };
}

/** Modeled fields from a parsed vCard, as a Contact patch (arrays -> JSON). */
function parsedToFields(p: ParsedContact): Partial<Contact> {
  return {
    fn: p.fn || displayName(p), prefix: p.prefix, first_name: p.first_name, middle_name: p.middle_name,
    last_name: p.last_name, suffix: p.suffix, nickname: p.nickname, org: p.org, title: p.title,
    bday: p.bday, anniversary: p.anniversary, notes: p.notes, categories: p.categories, photo: p.photo,
    phones: JSON.stringify(p.phones), emails: JSON.stringify(p.emails), addresses: JSON.stringify(p.addresses),
    urls: JSON.stringify(p.urls), impps: JSON.stringify(p.impps), related: JSON.stringify(p.related)
  };
}

/** The modeled fields of a local row, as a patch -- used to build a conflict copy. */
function localFields(c: Contact): Partial<Contact> {
  return {
    fn: c.fn, prefix: c.prefix, first_name: c.first_name, middle_name: c.middle_name, last_name: c.last_name,
    suffix: c.suffix, nickname: c.nickname, org: c.org, title: c.title, bday: c.bday, anniversary: c.anniversary,
    notes: c.notes, categories: c.categories, photo: c.photo, phones: c.phones, emails: c.emails,
    addresses: c.addresses, urls: c.urls, impps: c.impps, related: c.related, raw_vcard: c.raw_vcard
  };
}

function contactSignature(p: ParsedContact): string {
  const norm = (s: string) => (s || "").trim();
  const cats = norm(p.categories).split(",").map((x) => x.trim()).filter(Boolean).sort().join(",");
  return JSON.stringify({
    fn: norm(p.fn), prefix: norm(p.prefix), first: norm(p.first_name), middle: norm(p.middle_name),
    last: norm(p.last_name), suffix: norm(p.suffix), nick: norm(p.nickname), org: norm(p.org),
    title: norm(p.title), bday: p.bday || "", anniversary: p.anniversary || "", notes: norm(p.notes),
    cats, phones: p.phones, emails: p.emails, addresses: p.addresses, urls: p.urls, impps: p.impps, related: p.related
  });
}

/** True when the remote vCard carries the same modeled content as the local
 *  row -- then an etag difference is just a version-stamp move (often our own
 *  last push), not a real remote edit. Photo/raw excluded (encoding varies). */
function sameContactContent(local: Contact, remote: ParsedContact): boolean {
  return contactSignature(contactToParsed(local)) === contactSignature(remote);
}

export interface ContactSyncResult {
  bookId: string;
  pulled: number;
  pushed: number;
  errors: string[];
}

/** Two-way sync for every address book linked to this account. */
/** Yield the main-process event loop so queued IPC (create/edit/load a task,
 *  save keystrokes) is serviced between chunks of a sync. node:sqlite is
 *  synchronous, so without this a large pull (hundreds of contacts) monopolizes
 *  the single thread and the UI can't be interacted with until it finishes.
 *  Purely a scheduling breather -- it changes nothing about what syncs. */
function yieldTick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export async function syncAccountContacts(account: CaldavAccount): Promise<ContactSyncResult[]> {
  const client = await clientFor(account);
  const books = addressBooksAll().filter((b) => b.carddav_account_id === account.id && b.carddav_addressbook_url);
  const results: ContactSyncResult[] = [];
  for (const book of books) results.push(await syncAddressBook(client, book));
  return results;
}

async function syncAddressBook(client: Client, book: AddressBook): Promise<ContactSyncResult> {
  const result: ContactSyncResult = { bookId: book.id, pulled: 0, pushed: 0, errors: [] };
  const url = book.carddav_addressbook_url!;
  syncLog(`--- carddav sync start: book "${book.name}" (${url})`);

  try {
    const objects = await Promise.race([
      client.fetchVCards({ addressBook: { url } as any }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("fetchVCards timed out after 15s")), 15000))
    ]);

    const remoteByUid = new Map<string, { url: string; etag: string; data: string; parsed: ParsedContact }>();
    const remoteUids = new Set<string>();
    const groupRemoteUids = new Set<string>();
    let groupsSeen = 0;
    const db0 = getDb();
    let parseIdx = 0;
    for (const obj of objects) {
      if ((parseIdx++ % 20) === 0) await yieldTick();
      const data = obj.data || "";
      // Synology/DAVx5 store labels ("DP21", "wedding") as separate group cards
      // that list members by UID. Divert those into contact_groups so their
      // membership becomes labels, instead of importing them as phantom
      // "contacts" (which is why those labels showed up empty).
      const group = parseGroupCard(data);
      if (group) {
        contactGroupUpsert({
          address_book_id: book.id,
          name: group.name,
          carddav_uid: group.uid,
          carddav_href: obj.url,
          carddav_etag: obj.etag || "",
          member_uids: group.memberUids,
          raw_vcard: data
        });
        if (group.uid) {
          groupRemoteUids.add(group.uid);
          // Clean up a phantom contact row imported from this group card by an
          // earlier (pre-fix) build.
          db0.prepare(`DELETE FROM contacts WHERE address_book_id = ? AND carddav_uid = ?`).run(book.id, group.uid);
        }
        groupsSeen++;
        continue;
      }
      const parsed = parseVCard(data);
      if (!parsed || !parsed.uid) continue;
      remoteUids.add(parsed.uid);
      remoteByUid.set(parsed.uid, { url: obj.url, etag: obj.etag || "", data, parsed });
    }

    // Includes soft-deleted rows -- a local delete not yet pushed must not be
    // resurrected by the pull loop below.
    const localByUid = contactsByBookWithUid(book.id);

    // Pull.
    let pullIdx = 0;
    for (const [uid, remote] of remoteByUid) {
      if ((pullIdx++ % 20) === 0) await yieldTick();
      const parsed = remote.parsed;
      const local = localByUid.get(uid);
      if (local?.deleted) continue;
      if (!local) {
        contactCreate({
          address_book_id: book.id,
          ...parsedToFields(parsed),
          raw_vcard: remote.data,
          carddav_uid: uid,
          carddav_href: remote.url,
          carddav_etag: remote.etag,
          dirty: 0
        });
        result.pulled++;
        continue;
      }
      if (local.carddav_etag !== remote.etag) {
        if (sameContactContent(local, parsed)) {
          contactUpdate(local.id, { carddav_href: remote.url, carddav_etag: remote.etag });
          continue;
        }
        if (local.dirty) {
          syncLog(`CONFLICT on contact "${local.fn}" (${uid}): remote wins, local saved as "(conflicted copy)"`);
          contactCreate({
            address_book_id: book.id,
            ...localFields(local),
            fn: `${local.fn} (conflicted copy)`,
            dirty: 1
          });
        } else {
          syncLog(`pull overwrite of clean contact "${local.fn}" (${uid})`);
        }
        contactUpdate(local.id, {
          ...parsedToFields(parsed),
          raw_vcard: remote.data,
          carddav_href: remote.url,
          carddav_etag: remote.etag
        });
        result.pulled++;
      }
    }

    // Push: local contacts that are new or have unpushed edits.
    const needEtagRefresh: { id: string; href: string; name: string }[] = [];
    const freshLocal = contactsByBook(book.id);
    for (const local of freshLocal) {
      if (!local.carddav_uid) {
        const { uid, vcf } = contactToVCard(contactToParsed(local));
        const filename = `${uid}.vcf`;
        const href = `${url}${filename}`;
        try {
          const resp = await client.createVCard({ addressBook: { url } as any, vCardString: vcf, filename });
          const etag = resp.headers?.get?.("etag") || null;
          contactUpdate(local.id, { carddav_uid: uid, carddav_href: href, carddav_etag: etag, raw_vcard: vcf } as Partial<Contact>);
          if (!etag) needEtagRefresh.push({ id: local.id, href, name: local.fn });
          remoteUids.add(uid);
          syncLog(`pushed new contact "${local.fn}" (${uid})${etag ? "" : " — no etag in response"}`);
          result.pushed++;
        } catch (err: any) {
          syncLog(`push create FAILED for contact "${local.fn}": ${err?.message || err}`);
          result.errors.push(`Create failed for "${local.fn}": ${err?.message || err}`);
        }
      } else {
        if (!local.dirty) continue;
        const remote = remoteByUid.get(local.carddav_uid);
        if (!remote) {
          // Gone from the server. Comparing a null remote etag skipped this on
          // every future sync, and contactsPruneMissing skips dirty rows, so a
          // local edit could never escape. Re-create under the same UID.
          const { vcf } = contactToVCard(contactToParsed(local), local.raw_vcard);
          const filename = `${local.carddav_uid}.vcf`;
          const href = `${url}${filename}`;
          try {
            const resp = await client.createVCard({ addressBook: { url } as any, vCardString: vcf, filename });
            const etag = resp.headers?.get?.("etag") || null;
            contactUpdate(local.id, { carddav_href: href, carddav_etag: etag, raw_vcard: vcf } as Partial<Contact>);
            if (!etag) needEtagRefresh.push({ id: local.id, href, name: local.fn });
            remoteUids.add(local.carddav_uid);
            syncLog(`re-created missing contact "${local.fn}" (${local.carddav_uid}) to unwedge a dirty edit`);
            result.pushed++;
          } catch (err: any) {
            syncLog(`re-create FAILED for missing contact "${local.fn}": ${err?.message || err}`);
            result.errors.push(`Re-create failed for "${local.fn}": ${err?.message || err}`);
          }
          continue;
        }
        if (remote.etag !== local.carddav_etag) {
          syncLog(`push skipped for dirty contact "${local.fn}": etag moved this round (${local.carddav_etag} vs ${remote.etag})`);
          continue;
        }
        const { vcf } = contactToVCard(contactToParsed(local), local.raw_vcard);
        const href = local.carddav_href || remote?.url || "";
        try {
          const resp = await client.updateVCard({ vCard: { url: href, data: vcf, etag: local.carddav_etag || "" } });
          const etag = resp.headers?.get?.("etag") || null;
          contactUpdate(local.id, { carddav_etag: etag || local.carddav_etag, raw_vcard: vcf } as Partial<Contact>);
          if (!etag) needEtagRefresh.push({ id: local.id, href, name: local.fn });
          syncLog(`pushed update contact "${local.fn}" (${local.carddav_uid})${etag ? "" : " — no etag in response"}`);
          result.pushed++;
        } catch (err: any) {
          syncLog(`push update FAILED for contact "${local.fn}": ${err?.message || err}`);
          result.errors.push(`Update failed for "${local.fn}": ${err?.message || err}`);
        }
      }
    }

    // Fetch real etags for anything the server didn't stamp on PUT.
    if (needEtagRefresh.length) {
      try {
        const fresh = await client.fetchVCards({ addressBook: { url } as any, objectUrls: needEtagRefresh.map((o) => o.href) });
        for (const o of needEtagRefresh) {
          const obj = fresh.find((f) => samePath(f.url, o.href));
          if (obj?.etag) contactUpdate(o.id, { carddav_etag: obj.etag } as Partial<Contact>);
        }
      } catch (err: any) {
        syncLog(`contact etag refresh failed: ${err?.message || err}`);
      }
    }

    // Local deletions (soft-deleted contacts that were already synced).
    const db = getDb();
    const deletedWithRemote = db
      .prepare(`SELECT * FROM contacts WHERE address_book_id = ? AND deleted = 1 AND carddav_uid IS NOT NULL`)
      .all(book.id) as unknown as Contact[];
    for (const c of deletedWithRemote) {
      try {
        await client.deleteVCard({ vCard: { url: c.carddav_href || "", etag: c.carddav_etag || "" } });
      } catch (err: any) {
        syncLog(`contact delete FAILED for "${c.fn}": ${err?.message || err}`);
      }
      contactDelete(c.id, true);
    }

    contactsPruneMissing(book.id, remoteUids);
    contactGroupsPruneMissing(book.id, groupRemoteUids);
    syncLog(`carddav: synced book "${book.name}" — pulled ${result.pulled}, pushed ${result.pushed}, ${groupsSeen} group card(s) → labels`);
  } catch (err: any) {
    syncLog(`carddav sync FAILED for book "${book.name}": ${err?.message || err}`);
    result.errors.push(err?.message || String(err));
  }

  return result;
}

// ---------- vCard file import (workaround for labels Synology won't export) ----------

/** Split a .vcf file (which may contain many cards) into individual vCard
 *  blocks. */
function splitVCards(text: string): string[] {
  const out: string[] = [];
  const re = /BEGIN:VCARD[\s\S]*?END:VCARD/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push(m[0]);
  return out;
}

const normKey = (s: string) => (s || "").trim().toLowerCase().replace(/\s+/g, " ");

/** Normalized display name for matching (prefers FN, falls back to first+last). */
function nameKeyParsed(p: ParsedContact): string {
  return normKey(p.fn || `${p.first_name} ${p.last_name}`);
}
function nameKeyContact(c: Contact): string {
  return normKey(c.fn || `${c.first_name} ${c.last_name}`);
}

function emailSetFromJson(json: string): Set<string> {
  const out = new Set<string>();
  try {
    const arr = JSON.parse(json || "[]");
    if (Array.isArray(arr)) for (const e of arr) { const v = normKey(e?.value); if (v) out.add(v); }
  } catch { /* ignore */ }
  return out;
}
function emailSetFromParsed(p: ParsedContact): Set<string> {
  const out = new Set<string>();
  for (const e of p.emails) { const v = normKey(e.value); if (v) out.add(v); }
  return out;
}
function shareAny(a: Set<string>, b: Set<string>): boolean {
  for (const x of a) if (b.has(x)) return true;
  return false;
}

/** Union label(s) into an existing comma-separated categories string,
 *  de-duplicated case-insensitively. Returns the new string (unchanged if the
 *  labels were already present). */
function addCategories(existing: string, ...toAdd: string[]): string {
  const cur = (existing || "").split(",").map((s) => s.trim()).filter(Boolean);
  const seen = new Set(cur.map((s) => s.toLowerCase()));
  for (const raw of toAdd) {
    for (const label of (raw || "").split(",").map((s) => s.trim()).filter(Boolean)) {
      if (!seen.has(label.toLowerCase())) { cur.push(label); seen.add(label.toLowerCase()); }
    }
  }
  return cur.join(", ");
}

export interface ImportSummary {
  total: number;        // cards read from the file (excluding group cards)
  labeled: number;      // existing contacts that gained the label
  matched: number;      // cards matched to an existing contact
  created: number;      // genuinely new contacts added
  skipped: number;      // unmatched cards, when createNew was false
}

/** Import contacts from raw .vcf text. Matches each card to an existing contact
 *  by CardDAV UID, then by (same name + shared email), so re-importing the same
 *  people does not create duplicates -- it just merges. A non-empty `label` is
 *  added to every matched/created contact's CATEGORIES (that's the workaround
 *  for Synology labels that don't travel over CardDAV). Matched updates mark the
 *  contact dirty, so the label rides up to the server on the next sync. */
export function importVCards(text: string, opts: { label: string; bookId: string; createNew: boolean }): ImportSummary {
  const summary: ImportSummary = { total: 0, labeled: 0, matched: 0, created: 0, skipped: 0 };
  const label = (opts.label || "").trim();

  const existing = contactsAll();
  const byUid = new Map<string, Contact>();
  for (const c of existing) if (c.carddav_uid) byUid.set(c.carddav_uid, c);

  const findMatch = (p: ParsedContact): Contact | undefined => {
    if (p.uid && byUid.has(p.uid)) return byUid.get(p.uid);
    const nk = nameKeyParsed(p);
    if (!nk) return undefined;
    const pEmails = emailSetFromParsed(p);
    if (pEmails.size === 0) return undefined; // need an email to match confidently
    for (const c of existing) {
      if (nameKeyContact(c) !== nk) continue;
      if (shareAny(pEmails, emailSetFromJson(c.emails))) return c;
    }
    return undefined;
  };

  for (const block of splitVCards(text)) {
    if (parseGroupCard(block)) continue; // ignore group cards
    const p = parseVCard(block);
    if (!p) continue;
    summary.total++;
    const match = findMatch(p);
    if (match) {
      summary.matched++;
      const next = addCategories(match.categories, label, p.categories);
      if (next !== match.categories) { contactUpdate(match.id, { categories: next }); summary.labeled++; }
    } else if (opts.createNew) {
      const created = contactCreate({
        address_book_id: opts.bookId,
        ...parsedToFields(p),
        categories: addCategories(p.categories, label),
        raw_vcard: block
      });
      summary.created++;
      if (label) summary.labeled++;
      existing.push(created);
    } else {
      summary.skipped++;
    }
  }
  return summary;
}

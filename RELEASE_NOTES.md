Daynizer v0.6.1 — sync-server compatibility fixes

Changes since 0.6.0. Daynizer is still beta.

## CalDAV / CardDAV — works with a brand-new server
- **Create the first list on an empty server.** Creating a list/calendar on the server now works even
  when the account has no calendars yet. Daynizer asks the server for your calendar home directly
  instead of deriving it from an existing calendar, so adding a brand-new or self-hosted CalDAV account
  (e.g. a fresh Radicale/Baïkal/Nextcloud user with nothing on it yet) and creating your first list
  works. Previously this failed with "No existing calendars found on server."
- **Create an address book on the server.** You can now create a contacts collection directly on a
  CardDAV server, the same way lists are created on a CalDAV server.
- **New accounts get default collections automatically.** When you add an account whose server has no
  calendars and/or no address books yet, Daynizer creates a default "Calendar" and "Contacts"
  collection for you, so the account is usable immediately without touching the server's own admin
  interface. Servers that already have collections (Synology, Nextcloud, …) are left untouched.
- **A newly added account appears right away.** After adding an account in Settings, it now shows up
  immediately in the "+ New list → On server" dropdown instead of only after restarting the app.

## Contacts & UI
- **Create an address book on the server or locally.** The "New address book" form now offers the same
  Local / On-server choice the calendar/list sidebar has, so you can make a contacts collection on a
  server directly.
- **Adding an account no longer freezes the form.** The default-collection setup after you save an
  account now runs in the background, so the Add Account form stays responsive instead of blocking
  until the server round-trips finish.
- **Clearer button label.** The sidebar's "New list" button is now "New list/calendar", since a list
  and a calendar are the same thing in Daynizer.
- **Sync marker in the contact's address-book picker.** The address-book dropdown in a contact's
  details now shows the ⇄ sync symbol next to server-synced books, so a synced "Contacts" is
  distinguishable from a local one (matching the sidebar).
- **Rename an address book.** Right-click an address book in the Contacts sidebar → Rename (inline,
  like lists). For a server-synced book the new name is pushed to the server (PROPPATCH displayname),
  matching how list rename works.

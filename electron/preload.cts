import { contextBridge, ipcRenderer } from "electron";

const api = {
  app: {
    version: () => ipcRenderer.invoke("app:version"),
    installUpdate: () => ipcRenderer.invoke("update:install")
  },
  settings: {
    all: () => ipcRenderer.invoke("settings:all"),
    set: (key: string, value: string) => ipcRenderer.invoke("settings:set", key, value)
  },
  lists: {
    all: () => ipcRenderer.invoke("lists:all"),
    create: (name: string, color?: string) => ipcRenderer.invoke("lists:create", name, color),
    update: (id: string, patch: any) => ipcRenderer.invoke("lists:update", id, patch),
    delete: (id: string) => ipcRenderer.invoke("lists:delete", id),
    export: (id: string) => ipcRenderer.invoke("lists:export", id)
  },
  tasks: {
    all: () => ipcRenderer.invoke("tasks:all"),
    byList: (listId: string) => ipcRenderer.invoke("tasks:byList", listId),
    subtasks: (parentId: string) => ipcRenderer.invoke("tasks:subtasks", parentId),
    create: (input: any) => ipcRenderer.invoke("tasks:create", input),
    update: (id: string, patch: any) => ipcRenderer.invoke("tasks:update", id, patch),
    toggleComplete: (id: string) => ipcRenderer.invoke("tasks:toggleComplete", id),
    delete: (id: string, hard?: boolean) => ipcRenderer.invoke("tasks:delete", id, hard)
  },
  events: {
    all: () => ipcRenderer.invoke("events:all"),
    create: (input: any) => ipcRenderer.invoke("events:create", input),
    update: (id: string, patch: any) => ipcRenderer.invoke("events:update", id, patch),
    delete: (id: string, hard?: boolean) => ipcRenderer.invoke("events:delete", id, hard)
  },
  addressbooks: {
    all: () => ipcRenderer.invoke("addressbooks:all"),
    create: (name: string, color?: string) => ipcRenderer.invoke("addressbooks:create", name, color),
    update: (id: string, patch: any) => ipcRenderer.invoke("addressbooks:update", id, patch),
    delete: (id: string) => ipcRenderer.invoke("addressbooks:delete", id),
    discover: (accountId: string) => ipcRenderer.invoke("addressbooks:discover", accountId),
    link: (bookId: string, accountId: string, url: string) => ipcRenderer.invoke("addressbooks:link", bookId, accountId, url),
    connect: (accountId: string, url: string, displayName: string) => ipcRenderer.invoke("addressbooks:connect", accountId, url, displayName),
    unlink: (bookId: string) => ipcRenderer.invoke("addressbooks:unlink", bookId),
    createServer: (accountId: string, name: string) => ipcRenderer.invoke("addressbooks:createServer", accountId, name)
  },
  maintenance: {
    dedupe: (dryRun?: boolean) => ipcRenderer.invoke("maintenance:dedupe", dryRun)
  },
  contacts: {
    all: () => ipcRenderer.invoke("contacts:all"),
    byBook: (bookId: string) => ipcRenderer.invoke("contacts:byBook", bookId),
    create: (input: any) => ipcRenderer.invoke("contacts:create", input),
    update: (id: string, patch: any) => ipcRenderer.invoke("contacts:update", id, patch),
    delete: (id: string, hard?: boolean) => ipcRenderer.invoke("contacts:delete", id, hard),
    import: (opts: { label: string; bookId: string; createNew: boolean }) => ipcRenderer.invoke("contacts:import", opts),
    merge: (keeperId: string, loserIds: string[], patch: any) => ipcRenderer.invoke("contacts:merge", keeperId, loserIds, patch)
  },
  reminders: {
    for: (ownerType: "task" | "event", ownerId: string) => ipcRenderer.invoke("reminders:for", ownerType, ownerId),
    create: (ownerType: "task" | "event", ownerId: string, offsetMinutes: number) =>
      ipcRenderer.invoke("reminders:create", ownerType, ownerId, offsetMinutes),
    delete: (id: string) => ipcRenderer.invoke("reminders:delete", id)
  },
  accounts: {
    all: () => ipcRenderer.invoke("accounts:all"),
    // Electron has no CORS/host-permission model to satisfy -- see
    // src/types.ts's comment on this method for why it exists at all.
    ensureHostPermission: async (_serverUrl: string) => true,
    create: (input: any) => ipcRenderer.invoke("accounts:create", input),
    update: (id: string, patch: any) => ipcRenderer.invoke("accounts:update", id, patch),
    delete: (id: string) => ipcRenderer.invoke("accounts:delete", id),
    testConnection: (account: any) => ipcRenderer.invoke("accounts:testConnection", account),
    discoverCalendars: (accountId: string) => ipcRenderer.invoke("accounts:discoverCalendars", accountId),
    linkList: (listId: string, accountId: string, calendarUrl: string) =>
      ipcRenderer.invoke("accounts:linkList", listId, accountId, calendarUrl),
    connectCalendar: (accountId: string, calendarUrl: string, displayName: string, color?: string | null) =>
      ipcRenderer.invoke("accounts:connectCalendar", accountId, calendarUrl, displayName, color),
    unlinkList: (listId: string) => ipcRenderer.invoke("accounts:unlinkList", listId),
    sync: (accountId: string) => ipcRenderer.invoke("accounts:sync", accountId),
    createServerCalendar: (accountId: string, name: string) => ipcRenderer.invoke("accounts:createServerCalendar", accountId, name),
    deleteServerCalendar: (accountId: string, calendarUrl: string) => ipcRenderer.invoke("accounts:deleteServerCalendar", accountId, calendarUrl),
    bootstrapDefaults: (accountId: string) => ipcRenderer.invoke("accounts:bootstrapDefaults", accountId)
  },
  on: (channel: string, callback: (...args: any[]) => void) => {
    const listener = (_e: any, ...args: any[]) => callback(...args);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  }
};

contextBridge.exposeInMainWorld("api", api);

export type Api = typeof api;

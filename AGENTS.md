# AGENTS.md — dsh-session-purge

Maintainer briefing: which DSH facts this package rests on, which of them were
learned the hard way, and how to prove a change is safe.

Human-facing usage lives in [README.md](README.md) (中文) and
[README.en.md](README.en.md).

## What it is

A DSH plugin with two halves and no build step.

| Half | File | Job |
|---|---|---|
| Host (Node) | `lib/index.js` | Three HTTP endpoints: build the deletion plan, execute it, answer health |
| Browser | `lib/client.js` | Hand-written `window.__ModuleLoader__` bundle: the menu row and the confirmation dialog |
| Acceptance test | `verify/verify-host.mjs` | Drives the real plan and purge against a stub Host and a scratch DSH home |

Patch layer: `cordis.patch.yml` inserts one row (`id: session-purge`).

## The DSH facts everything rests on

### 1. Nothing in DSH deletes a Session

- `@deepseek-ai/dsh-session-persistence`: *"No deletion or retention API — pruning
  stored sessions is out-of-band backend maintenance."*
- `@deepseek-ai/dsh-session-persistence-jsonl`: *"Nothing deletes session files."*
- `@deepseek-ai/dsh-attachment-local`: stored images are *"never deleted
  automatically"*, and unreferenced objects are never collected.

So this package *is* that out-of-band maintenance — but it runs inside the Host
process, which is what lets it read a log through `ctx.sessionPersistence.open(id,
'read')` instead of re-implementing Zstandard frame scanning. Do not replace that
read with a hand-rolled file decoder: the log is a concatenation of independent
Zstandard frames, and magic-byte scanning finds false positives inside compressed
payloads.

### 2. On-disk layout

```text
<DSH_HOME>/sessions/<readable project dir>/<session id>/session.vN.jsonl.zstd
```

- `DSH_HOME` resolves as configured path → `$DSH_HOME` → `~/.dsh`. The Host half
  tries `@deepseek-ai/dsh-home-paths` dynamically and falls back to
  `$DSH_HOME ?? ~/.dsh`; a dynamic import keeps the half loadable where that
  library cannot be resolved.
- The session id **is** the directory name. Ids seen in the wild:
  `<uuid>` and `session-<uuid>`. The validation regex therefore accepts
  `[A-Za-z0-9][A-Za-z0-9._-]{0,150}` and nothing else — that is what makes
  joining an id onto the sessions root safe.
- The first stored row is the header:
  `{ type: 'session', version: 4, id, createdAt, cwd?, isSeeded, ... }`.
  The `cwd` is the only record of the Session's working directory; without it the
  plugin refuses to delete produced files rather than guess.
- Every later row is an event: `{ type, seq, time, data, surfaceOp? }`.
  `tool/call` data is `{ turn, step, callId, name, arguments }` where
  `arguments` is a **JSON string**. Writing tools name their target
  `file_path` (`write`, `edit`) or `path` (`str_replace_editor`); see
  `WRITE_TOOL_PATHS`.
- Attachment references appear as content blocks
  `{ type: 'image' | 'file', attachment: { attachmentId, ... } }`; the scanner
  walks every event for an `attachmentId` string rather than depending on which
  message kind carried it.

### 3. Attachment storage is shared

`<DSH_HOME>/attachments/v1/objects/<first two hex>/<sha256>` holds normalized
images, `file-objects/` holds generic file bytes, and `files/<prefix>/<digest>/`
holds one read-only hard-link directory per stored name. Objects are
**content-addressed and deduplicated, so they belong to no single conversation** —
which is why the "everything" scope asks every other stored Session before it
deletes one, and treats any read failure as "still referenced".

### 4. The browser half is a loader bundle, not a built module

```js
window.__ModuleLoader__.load({
  id: 'dsh-session-purge',            // must equal the package name
  factory: (require) => { /* … */ return { name, inject, apply } },
})
```

- `id` is the resolved package name: the module system identifies the browser
  module by it.
- The factory returns the Cordis plugin namespace: `name`, `inject`, `apply`.
  This half declares `inject: ['slots', 'locale']` and **no** `Config`.
- `require('react')`, `require('react/jsx-runtime')` and
  `require('@deepseek-ai/dsh-client-ui-primitives')` resolve against the shell's
  frozen static table; anything else would need `dsh.client.external`.
- No build step: `lib/client.js` is the shipped artifact. Executing the file only
  registers the factory; the body runs at materialization.

### 5. Slot contracts

| Slot | Kind | What is registered |
|---|---|---|
| `sidebar.workspaces.session.menu.item` | list, root | One menu row. Owner props are `{ sessionId, displayTitle }`; the owner publishes `hooks: { menuOpenState }`, which arrives as the `useMenuOpenState` prop. Shipped orders: `pin` 100, `rename` 200, `fork` 300, `archive` 400 — this package uses **410** so it lands directly under Archive. |
| `shell.overlay` | list, root | The confirmation dialog, portaled over the whole frame. |

- A registration's `inject` is a **factory** whose result is merged into the
  component's props (`inject: () => ({ purgeStore })`).
- `locale: NS` makes the component receive `t`; the namespace is registered with
  `ctx.locale.register(NS, { zh, en })` and must match the keys used in code.
- Dialog state is a module-local store read with `React.useSyncExternalStore`.
  The dialog is a body portal, so it is wrapped in an error boundary: an uncaught
  render error there would unmount the application root, not just the dialog.

### 6. Routes, and why they carry a marker header

`ctx.effect(() => ctx.webServer.register({ kind: 'exact', path, handler }), label)`
registers an endpoint; the web server resolves longer paths first, so `/api/...`
exact routes never shadow the plugin's own bundle under `/plugins/<pkg>/`.

**`/plugins` routes answer without the shell's session authorization.** That is
why both write endpoints demand the header `x-dsh-session-purge: 1` and reject an
`Origin` that is not the request's own host. Without it, any local page could POST
a purge (a cross-origin simple request executes even though its response cannot be
read).

## Rules learned the hard way

| Rule | What happens if it is broken |
|---|---|
| **Never read or write a CJK-bearing file with PowerShell.** Use the file tools, and verify with Node `readFileSync(path, 'utf8')`. | Windows PowerShell 5.1 decodes BOM-less UTF-8 as GBK: `Get-Content package.json` prints `鍦ㄤ細璇濄€屽綊妗ｃ€?` for perfectly intact Chinese, and a `Set-Content` round-trip would destroy it for real. A display that looks like mojibake is not proof the file is broken — check with the read tool before "fixing" it. |
| **The Loader caches an imported Host module per package name.** Disabling/enabling the plugin, or removing and reinstalling the bundle, does **not** re-read `lib/index.js`; changing the manifest's `main` to a new filename did not either. | You keep testing the old revision and conclude a fix did not work. Host-half changes need a **DSH restart**. To prove which revision is live, probe a behavioral difference (here: the marker header), not the file's mtime. |
| **The browser half *is* hot.** `client-modules` derives a revision from the bundle file's mtime/size and pushes it into open pages. | You restart DSH for a cosmetic change. To prove the browser half is live, change something observable (the row's `order`) and re-read the slot inspector. |
| **`web_fetch` refuses loopback URLs** (`non-public IP address`). | You conclude the endpoint is unreachable. Probe it with `Invoke-WebRequest http://127.0.0.1:<port>/...` instead. |
| **`plugin_manager` needs `danger-full-access` approval, and `remove_bundle` succeeds before `install_bundle` is approved.** | A cancelled approval can leave the plugin *removed*. After any cancelled escalation, re-read the profile's `package.json` and the health endpoint before assuming state. |
| **`set_plugin` addresses the Loader entry id, not the package name.** Here it is `include:session-purge`; `session-purge` and `dsh-session-purge` both answer `unknown-plugin`. | The toggle silently fails and the entry keeps running. |
| **Never delete a directory in the "produced files" scope.** | A wrong or empty path list would take a tree with it. Only files are removed; the Session's own storage directory is the single exception. |
| **Compare real paths, and only inside the recorded `cwd`.** | A symlink inside the working directory could otherwise point anywhere on disk. |
| **A live Session is archived with `stopActivity: true` before deletion.** | Running work keeps writing while the files disappear, and a late wake-up recreates a log with no Session behind it. |
| **`api-session/removed` is best-effort.** | You rely on it to refresh the sidebar. It may not reach the page; the dialog reloads the page on success, and that is the guarantee. |
| **The verification suite must clean up its own `.scratch` root, not just the leaf.** | `rm(join(here,'..','.scratch','verify-host'))` leaves an empty `.scratch/` behind, so a fresh clone is not byte-identical to a tested tree. |

## Verifying a change

```sh
node --check lib/index.js
node --check lib/client.js
node verify/verify-host.mjs     # or: pnpm verify
```

`verify/verify-host.mjs` is offline and self-contained: a scratch DSH home, a stub
`sessionPersistence` (synthetic events, one "other" Session for the shared-object
path), a stub `webServer` that records routes and drives their handlers through a
fake request/response, and a stub `workspaceRegistry`. It asserts both what the
plan selects and what the purge *actually removes* — including the files and
directories that must survive. Extend it whenever a scope changes; a test that
only checks the plan can pass while the deletion does nothing.

Live smoke test (read-only), with the plugin installed:

```powershell
Invoke-WebRequest -Uri "http://127.0.0.1:19387/plugins/dsh-session-purge/api/health" -UseBasicParsing
Invoke-WebRequest -Uri "http://127.0.0.1:19387/plugins/dsh-session-purge/api/scan" -Method POST `
  -ContentType 'application/json' -Headers @{'x-dsh-session-purge'='1'} `
  -Body (@{ sessionId = '<a real id from ~/.dsh/sessions/*/*>' } | ConvertTo-Json) -UseBasicParsing
```

## Change → restart matrix

| Changed | To see it |
|---|---|
| `lib/client.js` | Nothing — `client-modules` HMR pushes the new bundle into open pages. Verify by changing the row's `order` and re-reading the slot inspector. |
| `lib/index.js` | **Restart DSH.** Toggling or reinstalling the bundle does not re-import it. |
| `cordis.patch.yml`, `package.json` | Re-apply the plugin (plugin manager enable) or restart. |
| `README.md`, `AGENTS.md`, `CHANGELOG.md`, `LICENSE` | Nothing. |

## When someone reports something

| Report | Look at | Most likely |
|---|---|---|
| "No 删除对话 row in the menu" | `cordis_inspect_query` (client `Slots`, root `sidebar.workspaces.session.menu.item`) for the `purge-session` occupant | The browser half did not load, or its `inject: ['slots','locale']` is unsatisfied. |
| "The dialog says 缺少插件请求标记" | The client bundle's `x-dsh-session-purge` header vs the Host's `requireOwnPage` | An old browser half (or an old Host half) is paired with a new counterpart; reload the page, restart DSH. |
| "The list still shows the conversation" | Whether the page reloaded after the purge | `api-session/removed` did not reach the page; the durable truth is the deleted log. |
| "It deleted the files I did not expect" | The scan list in the dialog, then `WRITE_TOOL_PATHS` and the `cwd` containment check | The conversation really did write them under its working directory. Only paths the Session's own writing tools named are eligible. |
| "Deletion failed on a running conversation" | The error rows in the dialog | A live write handle still holds the log (Windows). Retry after the turn ends. |
| "My attachment is gone after 彻底删除" | `dsh-attachment-local`'s layout and the shared-object scan | No other stored Session referenced it, so the object was removed on purpose. |
| "The row is in the wrong place" | The registration's `order` | It must stay above 400 to sit under Archive; reusing a shipped `id` at another `priority` would shadow that shipped row instead. |

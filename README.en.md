# dsh-session-purge

**A "Delete conversation…" row that sits right under "Archive session" in the DeepSeek Harness sidebar.**
Pick a scope, then remove the conversation for good — together with the files you chose to take with it.

English | [简体中文](README.md)

> ⚠️ Deletion cannot be undone. The plugin shows you the Host's scan before it touches anything, and the confirm button stays disabled until you acknowledge it. Try it on a conversation you do not need first.

## Features

- **Right next to Archive**: registered at `order: 410` in `sidebar.workspaces.session.menu.item`, where the shipped `archive` row sits at `400`.
- **Three delete scopes**, with a scan that lists exactly what will be removed, what was skipped, and why.
- **The Host decides**: the browser sends a Session id, a mode and a confirmation flag only; the plan is re-derived from the Session log on the Host, so a tampered page cannot widen the deletion.
- **A running conversation is stopped and archived first**, so nothing writes into a directory that is about to disappear.
- **Conservative about shared attachments**: an attachment object is deleted only after every other stored Session has been read and none references it.
- **42 offline assertions** (`node verify/verify-host.mjs`) — no DSH process, no ports, no prompts.

## The UI

Hover any Session row in the sidebar → click **⋯** → the row directly under **Archive session** is **Delete conversation…**.

The confirmation dialog renders four sections:

1. **Conversation record** — storage directories and their size;
2. **Files this conversation produced** — the list that would be deleted, with sizes, plus any entry the Host refused;
3. **Attachment objects** — how many this conversation references;
4. **Delete scope** radio group, plus the working directory (and a warning line when the conversation is currently running).

The footer holds Cancel and Delete. **Delete stays disabled until "I understand this cannot be undone" is checked.** On success the page reloads (~1.8s) to refresh the list.

## The three scopes

| Scope | Deleted | Kept |
|---|---|---|
| **Record only** | Every stored Session log file (`<DSH_HOME>/sessions/<project>/<session id>/`) and the Session's Workspace accounting row | Files the conversation produced on disk, attachment objects |
| **Record + the files it produced** (default) | All of the above, **plus** files the writing tools (`write` / `edit` / `str_replace_editor`) targeted | Only regular files whose real path is strictly inside the conversation's working directory; every other file, every directory, every attachment |
| **Everything (attachment objects too)** | All of the above, **plus** attachment objects no other conversation references | Attachment objects still referenced elsewhere |

> "Files this conversation produced" are what the Agent wrote into your working directory; "attachment objects" are the images/files you dragged into the composer. They are different things — see [How attachments are stored](#how-attachments-are-stored).

## Install

The plugin is a standard DSH bundle package and ships its own patch layer:

```yaml
- insert:
    - id: session-purge
      name: dsh-session-purge
```

### Option 1 — the plugin manager / `plugin_manager` tool

Point it at this directory's **absolute path** (the Host reads that directory's `package.json`). Installation adds the package to the profile's `dsh.profile.bundles` and enables it.

### Option 2 — from npm (after publishing)

```sh
dsh plugin --profile desktop add dsh-session-purge
```

### Option 3 — link it by hand

```powershell
mklink /J "%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-session-purge" "<this directory>"
```

Then append the `- insert:` block above to `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml` and restart DSH.

**When a change takes effect**: edits to the Host half (`lib/index.js`) need a DSH restart (the Loader caches imported modules per package name); edits to the browser half (`lib/client.js`) are pushed into the open page by `client-modules` HMR without a refresh.

## Usage

1. Session row → **⋯** → **Delete conversation…**;
2. read the list, pick a scope, tick the acknowledgement, press Delete;
3. the page reloads itself to refresh the list, or press **Reload now**.

## Why it can delete what DSH itself cannot

DSH's Session persistence layer has no deletion API at all:

- `@deepseek-ai/dsh-session-persistence`: *"No deletion or retention API — pruning stored sessions is out-of-band backend maintenance."*
- `@deepseek-ai/dsh-session-persistence-jsonl`: *"Nothing deletes session files."*
- `@deepseek-ai/dsh-attachment-local`: stored images are *"never deleted automatically"*, and nothing collects unreferenced objects.

This plugin is that out-of-band maintenance, performed **inside the Host process** so it can read a Session log through `ctx.sessionPersistence.open(id, 'read')` instead of re-implementing Zstandard frame handling.

## Safety boundaries (all enforced on the Host, never in the browser)

- A Session id must be **one safe path segment** (`[A-Za-z0-9][A-Za-z0-9._-]*`); no request value is ever concatenated into a path.
- A produced file is deleted only when its **real path is strictly inside the Session's recorded `cwd`** and outside the DSH home. Anything else — outside the directory, inside `DSH_HOME`, not a regular file, unresolvable through a symlink — is skipped and listed with its reason.
- **Only files are deleted** in that scope; directories are never removed (except a Session's own storage directory).
- An **attachment object is deleted only after every other stored Session has been read** and none references it; any read failure keeps the object.
- The browser never sends a path list, and the Host **re-derives the whole plan**, so nothing the page holds can widen the deletion.
- `/plugins` routes are not covered by the shell's session authorization, so both write endpoints require this plugin's own marker header `x-dsh-session-purge: 1` and reject a cross-origin `Origin`. Another page cannot set that header without a preflight the server does not answer, so a drive-by page cannot delete through your browser.

### How attachments are stored

Attachments are content-addressed under `<DSH_HOME>/attachments/v1/objects/<first two hex>/<sha256>` and **deduplicated by content, so they are global and belong to no single conversation**; generic files additionally live under `file-objects/` with read-only hard-link directories under `files/`. Because they are shared, the third scope asks every other conversation before deleting anything.

## Known limitations

- **A running or open conversation**: the plugin first archives it with `stopActivity: true` (stopping in-flight work and writing the durable archive set), then removes files. On Windows the log file may still be held by a write handle, in which case the deletion fails and the reason is shown in the dialog — retry after the current turn ends.
- **List refresh**: `api-session/removed` is broadcast best-effort; a page reload is the reliable path, and that is what the dialog does on success.
- **Shared attachments**: deduplication means one object can be referenced by several conversations, so "Everything" sometimes keeps an attachment on purpose.
- **Files written from `bash` / `pwsh` are not discovered**: only the target paths of writing tool calls are known; shell redirections are not in the list.
- **Verified against DSH `0.2.0-rc.2` only** (desktop / web profile). On another release, run the offline suite first and re-check the `sidebar.workspaces.session.menu.item` and `shell.overlay` slot contracts.

## Development

```text
dsh-session-purge/
├── package.json          # manifest: dsh.bundle.patch + dsh.client.platform
├── cordis.patch.yml      # the bundle layer that mounts this plugin in a profile
├── lib/
│   ├── index.js          # Host half: three HTTP endpoints, plan + purge
│   └── client.js         # Browser half: the menu row and the dialog (hand-written loader bundle)
├── verify/
│   └── verify-host.mjs   # offline verification suite (42 assertions)
├── README.md             # 简体中文
├── README.en.md          # this file
├── CHANGELOG.md
├── LICENSE               # MIT
└── .github/workflows/verify.yml
```

Neither half needs a build step: the Host half is plain ESM, the browser half is a hand-written `window.__ModuleLoader__` bundle.

```sh
node verify/verify-host.mjs   # or: pnpm verify
```

The suite runs against a scratch DSH home with a stub `sessionPersistence` and `webServer`, and asserts the real outcome of all three scopes — including "a file outside the working directory is untouched", "a file the conversation never wrote is untouched", "an attachment still referenced elsewhere is kept", "a traversal-shaped id is refused", and "a cross-origin request is refused". Maintainer notes (DSH contracts, pitfalls, debugging paths) live in [AGENTS.md](AGENTS.md).

## Publishing to a Git repository / npm

1. Replace the three `OWNER` placeholders in `package.json` with your GitHub username:

   ```json
   "repository": { "url": "git+https://github.com/OWNER/dsh-session-purge.git" },
   "homepage": "https://github.com/OWNER/dsh-session-purge#readme",
   "bugs": { "url": "https://github.com/OWNER/dsh-session-purge/issues" }
   ```

2. Initialize and push (Git must be installed locally; GitHub's web uploader or GitHub Desktop work too):

   ```sh
   git init
   git add .
   git commit -m "feat: dsh-session-purge 0.1.0"
   git branch -M main
   git remote add origin https://github.com/OWNER/dsh-session-purge.git
   git push -u origin main
   ```

3. Publish to npm (optional; afterwards `dsh plugin add dsh-session-purge` works):

   ```sh
   npm publish
   ```

The repository already carries `.gitignore`, `.gitattributes` (LF everywhere, Chinese kept as byte-exact UTF-8), `.editorconfig`, and a GitHub Actions workflow that runs the syntax checks and the offline suite on three platforms × Node 22/24.

## License

[MIT](LICENSE)

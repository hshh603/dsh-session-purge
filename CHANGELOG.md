# Changelog

All notable changes to this project are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-10-11

First release. Works against `@deepseek-ai/dsh` `0.2.0-rc.2`.

### Added

- A **删除对话…** row in the Session "⋯" menu, placed at `order: 410` — directly
  after the shipped **归档会话** row (`order: 400`).
- A confirmation dialog that renders the Host's scan before anything is removed:
  storage directories with their size, every file that would be deleted, the
  entries the Host refuses (and why), the attachment count, and whether the
  Session is currently open.
- Three delete modes: **record only**, **record + files this conversation
  produced** (default), and **everything** including attachment objects no other
  conversation references.
- Host endpoints `POST /plugins/dsh-session-purge/api/scan`,
  `POST /plugins/dsh-session-purge/api/purge`, and `GET .../api/health`.
- Deleting a live Session stops and archives it first, so no running work writes
  into a directory that is about to disappear.
- An offline verification suite (`node verify/verify-host.mjs`) that drives the
  real plan and purge code against a stub Host context and a scratch DSH home —
  42 assertions, no DSH process, no ports, no prompts.

### Safety

- A Session id is validated as a single safe path segment before it is used to
  locate anything.
- Produced files are deleted only when their real path is strictly inside the
  Session's recorded `cwd` and outside the DSH home; directories are never
  deleted in that mode.
- Attachment objects are deleted only after every other stored Session has been
  read and none references them; any read failure keeps the object.
- The browser sends a Session id, a mode and a confirmation flag only — the Host
  re-derives the whole plan, so a tampered page cannot widen the deletion.
- The write endpoints require this plugin's own marker header and reject a
  cross-origin `Origin`, so another page cannot drive a deletion through the
  user's browser.

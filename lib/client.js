/**
 * dsh-session-purge — browser half.
 *
 * Hand-written bundle in the module-loader format the shell expects: executing
 * it only registers a factory; the body runs at materialization. It contributes
 * two Slot entries and one tiny store:
 *
 *   * `sidebar.workspaces.session.menu.item` — the "删除对话…" row placed right
 *     after the shipped Archive row (which registers at order 400).
 *   * `shell.overlay` — the confirmation dialog, which selects the delete mode
 *     and renders exactly what the Host's scan reported.
 *
 * The dialog never decides what is deletable. It posts a Session id and a mode
 * to the Host half, which re-derives the plan, so nothing the page holds can
 * widen what is removed.
 */

window.__ModuleLoader__.load({
  id: 'dsh-session-purge',
  factory: (require) => {
    const React = require('react')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')

    const {
      Button,
      Checkbox,
      IconTrashOutlineRegular,
      IconWarningOutlineRegular,
      MenuItemButton,
      Modal,
    } = primitives

    /** Locale namespace; equals the package name by convention. */
    const NS = 'dsh-session-purge'

    /** This plugin's Host endpoints, served by the same web server as the page. */
    const API = '/plugins/dsh-session-purge/api'

    /** How long a successful purge stays on screen before the page reloads. */
    const RELOAD_DELAY_MS = 1800

    const ZH = {
      'menu.purge': '删除对话…',
      'dialog.title': '删除对话',
      'dialog.subtitle': '「{title}」',
      'dialog.scanning': '正在读取该对话的存储与文件…',
      'dialog.scanFailed': '无法读取该对话的删除计划：{reason}',
      'dialog.section.record': '对话记录',
      'dialog.section.artifacts': '本对话产出的文件',
      'dialog.section.attachments': '附件对象',
      'dialog.record.summary': '{dirs} 个存储目录 · {bytes}',
      'dialog.record.none': '未找到该对话的存储目录（可能已被删除）。',
      'dialog.artifacts.summary': '{count} 个文件 · {bytes}',
      'dialog.artifacts.none': '没有扫描到由该对话写入的文件。',
      'dialog.artifacts.more': '另有 {count} 个文件未在此列出。',
      'dialog.artifacts.refused': '已跳过 {count} 个不安全或已不存在的条目。',
      'dialog.attachments.summary': '该对话引用了 {count} 个附件对象。',
      'dialog.attachments.none': '该对话没有引用附件。',
      'dialog.mode.record': '仅删除对话记录',
      'dialog.mode.recordHint': '对话从列表中消失，磁盘上产出的文件保留。',
      'dialog.mode.artifacts': '删除对话记录 + 本对话产出的文件',
      'dialog.mode.artifactsHint': '只删除本对话写入过的文件，且必须位于该对话的工作目录内。',
      'dialog.mode.everything': '彻底删除（含附件对象）',
      'dialog.mode.everythingHint': '再删除没有任何其他对话引用的附件对象；仍被引用的会保留。',
      'dialog.live': '该对话当前处于打开/运行状态：删除会先停止并归档它，再删除文件。',
      'dialog.ack': '我已知晓：删除后无法恢复',
      'dialog.cancel': '取消',
      'dialog.confirm': '删除',
      'dialog.deleting': '正在删除…',
      'dialog.cwd': '工作目录：{path}',
      'dialog.noCwd': '该对话没有记录工作目录。',
      'dialog.failed': '删除失败：{reason}',
      'dialog.done.title': '已删除',
      'dialog.done.record': '已删除 {dirs} 个存储目录（{bytes}）。',
      'dialog.done.artifacts': '已删除 {count} 个产出文件（{bytes}）。',
      'dialog.done.attachments': '已删除 {count} 个附件路径。',
      'dialog.done.errors': '有 {count} 项未能删除，详见下方。',
      'dialog.done.reload': '页面将在 {seconds} 秒后重新加载以刷新列表。',
      'dialog.reloadNow': '立即重新加载',
      'dialog.close': '关闭',
      'dialog.warnings': '提示',
    }

    const EN = {
      'menu.purge': 'Delete conversation…',
      'dialog.title': 'Delete conversation',
      'dialog.subtitle': '"{title}"',
      'dialog.scanning': 'Reading this conversation\u2019s storage and files…',
      'dialog.scanFailed': 'Could not read the deletion plan: {reason}',
      'dialog.section.record': 'Conversation record',
      'dialog.section.artifacts': 'Files this conversation produced',
      'dialog.section.attachments': 'Attachment objects',
      'dialog.record.summary': '{dirs} storage directories · {bytes}',
      'dialog.record.none': 'No storage directory found for this conversation (it may already be gone).',
      'dialog.artifacts.summary': '{count} files · {bytes}',
      'dialog.artifacts.none': 'No file written by this conversation was found.',
      'dialog.artifacts.more': '{count} more files are not listed here.',
      'dialog.artifacts.refused': '{count} unsafe or missing entries were skipped.',
      'dialog.attachments.summary': 'This conversation references {count} attachment objects.',
      'dialog.attachments.none': 'This conversation references no attachments.',
      'dialog.mode.record': 'Delete the conversation record only',
      'dialog.mode.recordHint': 'The conversation leaves the list; files on disk are kept.',
      'dialog.mode.artifacts': 'Delete the record and the files it produced',
      'dialog.mode.artifactsHint': 'Only files this conversation wrote, strictly inside its working directory.',
      'dialog.mode.everything': 'Delete everything (attachment objects too)',
      'dialog.mode.everythingHint': 'Also removes attachment objects no other conversation references.',
      'dialog.live': 'This conversation is open or running: deletion stops and archives it before removing files.',
      'dialog.ack': 'I understand this cannot be undone',
      'dialog.cancel': 'Cancel',
      'dialog.confirm': 'Delete',
      'dialog.deleting': 'Deleting…',
      'dialog.cwd': 'Working directory: {path}',
      'dialog.noCwd': 'This conversation recorded no working directory.',
      'dialog.failed': 'Deletion failed: {reason}',
      'dialog.done.title': 'Deleted',
      'dialog.done.record': 'Removed {dirs} storage directories ({bytes}).',
      'dialog.done.artifacts': 'Removed {count} produced files ({bytes}).',
      'dialog.done.attachments': 'Removed {count} attachment paths.',
      'dialog.done.errors': '{count} items could not be removed; see below.',
      'dialog.done.reload': 'The page reloads in {seconds}s to refresh the list.',
      'dialog.reloadNow': 'Reload now',
      'dialog.close': 'Close',
      'dialog.warnings': 'Notes',
    }

    /** Human-readable byte size. */
    function formatBytes(bytes) {
      const value = typeof bytes === 'number' && Number.isFinite(bytes) ? bytes : 0
      if (value < 1024) return `${String(value)} B`
      const units = ['KB', 'MB', 'GB', 'TB']
      let size = value / 1024
      let unit = 0
      while (size >= 1024 && unit < units.length - 1) {
        size /= 1024
        unit += 1
      }
      return `${size >= 10 ? size.toFixed(0) : size.toFixed(1)} ${units[unit]}`
    }

    /** Interpolate `{name}` placeholders. */
    function format(template, values) {
      return String(template).replace(/\{(\w+)\}/g, (match, key) => (
        Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match
      ))
    }

    /** One cancelable request to a Host endpoint. */
    async function callHost(path, body) {
      const response = await fetch(`${API}${path}`, {
        method: 'POST',
        // The marker header identifies this plugin's own page to the Host route;
        // a cross-origin page cannot set it without a preflight the server does
        // not answer.
        headers: { 'content-type': 'application/json', 'x-dsh-session-purge': '1' },
        body: JSON.stringify(body),
      })
      let payload = null
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
      if (!response.ok || payload === null || payload.ok !== true) {
        const reason = payload?.error ?? `${response.status} ${response.statusText}`
        throw new Error(String(reason))
      }
      return payload
    }

    /**
     * The one piece of shared state: which Session the dialog is open for.
     * Module-local rather than a Cordis service, because both entries are
     * registered by this same plugin and nothing else reads it.
     */
    function createStore() {
      let value = null
      const listeners = new Set()
      return {
        getSnapshot: () => value,
        subscribe(listener) {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
        open(request) {
          value = request
          for (const listener of [...listeners]) listener()
        },
        close() {
          value = null
          for (const listener of [...listeners]) listener()
        },
      }
    }

    /** Small muted line. */
    function hint(key, text) {
      return React.createElement('p', {
        key,
        style: { margin: '4px 0', fontSize: 12, color: 'var(--dsw-alias-label-secondary)' },
      }, text)
    }

    /** One scrollable monospace path list. */
    function pathList(key, paths) {
      return React.createElement('div', {
        key,
        style: {
          maxHeight: 150,
          overflowY: 'auto',
          margin: '6px 0 2px',
          padding: '6px 8px',
          borderRadius: 6,
          background: 'var(--dsw-alias-bg-layer-2)',
          border: '1px solid var(--dsw-alias-border-l1)',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
          fontSize: 11,
          lineHeight: 1.6,
          wordBreak: 'break-all',
        },
      }, paths.map((path, index) => React.createElement('div', { key: `${index}:${path}` }, path)))
    }

    /**
     * The Session-menu row, placed directly after the shipped Archive row.
     * @param props - the slot's Session props, the owner's menu hook, and this
     *   plugin's store.
     */
    function PurgeMenuItem({ sessionId, displayTitle, useMenuOpenState, purgeStore, t }) {
      // The owner (WorkspaceBrowser) publishes this hook for every entry of the
      // menu list, exactly as it does for its own archive row. The guard is
      // static per mount, so the conditional call cannot change between renders;
      // a missing hook costs only the auto-dismiss.
      const openState = typeof useMenuOpenState === 'function' ? useMenuOpenState() : null
      const setMenuOpen = Array.isArray(openState) ? openState[1] : () => {}
      return React.createElement(MenuItemButton, {
        danger: true,
        icon: React.createElement(IconTrashOutlineRegular, { size: 14 }),
        onSelect: () => {
          if (typeof setMenuOpen === 'function') setMenuOpen(false)
          purgeStore.open({ sessionId, displayTitle, nonce: Date.now() })
        },
      }, t('menu.purge'))
    }

    /** The overlay entry: one form per request, keyed so its state dies with it. */
    function PurgeDialog({ purgeStore, t }) {
      const request = React.useSyncExternalStore(purgeStore.subscribe, purgeStore.getSnapshot)
      if (request === null) return null
      // The dialog renders into a body portal, so an uncaught render error here
      // would unmount the application root rather than just this dialog. The
      // boundary turns any such failure into readable text inside the modal.
      return React.createElement(PurgeBoundary, { t },
        React.createElement(PurgeForm, {
          key: `${request.sessionId}:${String(request.nonce)}`,
          request,
          purgeStore,
          t,
        }))
    }

    /** Containment for the dialog's own render and lifecycle failures. */
    class PurgeBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }

      static getDerivedStateFromError(error) {
        return { error }
      }

      componentDidCatch(error) {
        // Kept for the browser console; the panel below shows the message.
        console.error('dsh-session-purge: dialog failed', error)
      }

      render() {
        if (this.state.error === null) return this.props.children
        return React.createElement(Modal, {
          open: true,
          onClose: () => {},
          title: this.props.t('dialog.title'),
          closeLabel: this.props.t('dialog.close'),
        }, React.createElement('p', {
          role: 'alert',
          style: { margin: 0, fontSize: 12, color: 'var(--dsw-alias-state-error-primary)' },
        }, String(this.state.error?.message ?? this.state.error)))
      }
    }

    /** The confirmation form: scan, choose a mode, acknowledge, delete. */
    function PurgeForm({ request, purgeStore, t }) {
      const [plan, setPlan] = React.useState(null)
      const [scanError, setScanError] = React.useState(null)
      const [mode, setMode] = React.useState('artifacts')
      const [acknowledged, setAcknowledged] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [failure, setFailure] = React.useState(null)
      const [result, setResult] = React.useState(null)
      const [countdown, setCountdown] = React.useState(0)

      React.useEffect(() => {
        let cancelled = false
        callHost('/scan', { sessionId: request.sessionId })
          .then((payload) => { if (!cancelled) setPlan(payload) })
          .catch((error) => { if (!cancelled) setScanError(error instanceof Error ? error.message : String(error)) })
        return () => { cancelled = true }
      }, [request.sessionId])

      // After a successful purge the list on screen is already stale; reloading
      // is the only honest way to show what the Host now holds.
      React.useEffect(() => {
        if (result === null || !result.ok) return undefined
        setCountdown(Math.ceil(RELOAD_DELAY_MS / 1000))
        const tick = window.setInterval(() => {
          setCountdown((value) => (value > 0 ? value - 1 : 0))
        }, 1000)
        const timer = window.setTimeout(() => { window.location.reload() }, RELOAD_DELAY_MS)
        return () => {
          window.clearInterval(tick)
          window.clearTimeout(timer)
        }
      }, [result])

      const close = () => {
        if (busy) return
        purgeStore.close()
      }

      const confirm = () => {
        setBusy(true)
        setFailure(null)
        callHost('/purge', { sessionId: request.sessionId, mode, confirm: true })
          .then((payload) => { setResult(payload) })
          .catch((error) => { setFailure(error instanceof Error ? error.message : String(error)) })
          .finally(() => { setBusy(false) })
      }

      const body = []
      const title = request.displayTitle === undefined || request.displayTitle === ''
        ? request.sessionId
        : request.displayTitle

      if (result !== null && result.ok) {
        body.push(React.createElement('h3', { key: 'done', style: { margin: '0 0 6px' } }, t('dialog.done.title')))
        body.push(hint('done-record', format(t('dialog.done.record'), {
          dirs: result.removed?.directories?.length ?? 0,
          bytes: formatBytes(result.removed?.directoryBytes ?? 0),
        })))
        if (mode !== 'record') {
          body.push(hint('done-artifacts', format(t('dialog.done.artifacts'), {
            count: result.removed?.artifacts?.length ?? 0,
            bytes: formatBytes(result.removed?.artifactBytes ?? 0),
          })))
        }
        if (mode === 'everything') {
          body.push(hint('done-attachments', format(t('dialog.done.attachments'), {
            count: result.removed?.attachments?.length ?? 0,
          })))
        }
        if ((result.errors?.length ?? 0) > 0) {
          body.push(hint('done-errors', format(t('dialog.done.errors'), { count: result.errors.length })))
          body.push(pathList('done-errors-list', result.errors.map(row => `${row.step}: ${row.path ?? ''} — ${row.message}`)))
        }
        body.push(hint('done-reload', format(t('dialog.done.reload'), { seconds: countdown })))
      } else if (scanError !== null) {
        body.push(hint('scan-failed', format(t('dialog.scanFailed'), { reason: scanError })))
      } else if (plan === null) {
        body.push(hint('scanning', t('dialog.scanning')))
      } else {
        // Storage directories.
        body.push(React.createElement('h3', { key: 'record', style: { margin: '10px 0 2px', fontSize: 13 } },
          t('dialog.section.record')))
        const directories = plan.store?.directories ?? []
        if (directories.length === 0) body.push(hint('record-none', t('dialog.record.none')))
        else {
          body.push(hint('record-summary', format(t('dialog.record.summary'), {
            dirs: directories.length,
            bytes: formatBytes(plan.store?.bytes ?? 0),
          })))
          body.push(pathList('record-paths', directories))
        }

        // Produced files.
        body.push(React.createElement('h3', { key: 'artifacts', style: { margin: '10px 0 2px', fontSize: 13 } },
          t('dialog.section.artifacts')))
        const allowed = plan.artifacts?.allowed ?? []
        if (allowed.length === 0) body.push(hint('artifacts-none', t('dialog.artifacts.none')))
        else {
          body.push(hint('artifacts-summary', format(t('dialog.artifacts.summary'), {
            count: allowed.length,
            bytes: formatBytes(plan.artifacts?.totalBytes ?? 0),
          })))
          body.push(pathList('artifacts-paths', allowed.slice(0, 60).map(row => `${row.displayPath}  (${formatBytes(row.bytes)})`)))
          if (allowed.length > 60) {
            body.push(hint('artifacts-more', format(t('dialog.artifacts.more'), { count: allowed.length - 60 })))
          }
        }
        if ((plan.artifacts?.refused?.length ?? 0) > 0) {
          body.push(hint('artifacts-refused', format(t('dialog.artifacts.refused'), { count: plan.artifacts.refused.length })))
        }

        // Attachments.
        body.push(React.createElement('h3', { key: 'attachments', style: { margin: '10px 0 2px', fontSize: 13 } },
          t('dialog.section.attachments')))
        const attachmentIds = plan.attachments?.ids ?? []
        body.push(hint('attachments-summary', attachmentIds.length === 0
          ? t('dialog.attachments.none')
          : format(t('dialog.attachments.summary'), { count: attachmentIds.length })))

        // Working directory and live state.
        body.push(hint('cwd', plan.cwd === undefined || plan.cwd === null
          ? t('dialog.noCwd')
          : format(t('dialog.cwd'), { path: plan.cwd })))
        if (plan.live === true) {
          body.push(React.createElement('p', {
            key: 'live',
            style: {
              display: 'flex',
              gap: 6,
              alignItems: 'center',
              margin: '6px 0',
              fontSize: 12,
              color: 'var(--dsw-alias-state-warn-primary)',
            },
          }, [
            React.createElement(IconWarningOutlineRegular, { key: 'icon', size: 14 }),
            React.createElement('span', { key: 'text' }, t('dialog.live')),
          ]))
        }

        // Mode selection.
        const modes = [
          ['record', 'dialog.mode.record', 'dialog.mode.recordHint'],
          ['artifacts', 'dialog.mode.artifacts', 'dialog.mode.artifactsHint'],
          ['everything', 'dialog.mode.everything', 'dialog.mode.everythingHint'],
        ]
        body.push(React.createElement('div', {
          key: 'modes',
          style: {
            marginTop: 12,
            paddingTop: 10,
            borderTop: '1px solid var(--dsw-alias-border-l1)',
            display: 'grid',
            gap: 8,
          },
        }, modes.map(([value, labelKey, hintKey]) => React.createElement('label', {
          key: value,
          style: { display: 'grid', gridTemplateColumns: '18px 1fr', gap: 8, alignItems: 'start', cursor: 'pointer' },
        }, [
          React.createElement('input', {
            key: 'radio',
            type: 'radio',
            name: `dsh-session-purge-mode-${request.sessionId}`,
            checked: mode === value,
            onChange: () => { setMode(value) },
            style: { marginTop: 3 },
          }),
          React.createElement('span', { key: 'text' }, [
            React.createElement('span', { key: 'label', style: { display: 'block', fontSize: 13 } }, t(labelKey)),
            React.createElement('span', {
              key: 'hint',
              style: { display: 'block', fontSize: 11, color: 'var(--dsw-alias-label-secondary)' },
            }, t(hintKey)),
          ]),
        ]))))

        // Notes from the Host.
        const warnings = plan.warnings ?? []
        if (warnings.length > 0) {
          body.push(hint('warnings-title', t('dialog.warnings')))
          body.push(pathList('warnings', warnings))
        }

        // Explicit acknowledgement.
        body.push(React.createElement('div', { key: 'ack', style: { marginTop: 10 } },
          React.createElement(Checkbox, {
            checked: acknowledged,
            onChange: setAcknowledged,
            label: t('dialog.ack'),
          })))

        if (failure !== null) {
          body.push(React.createElement('p', {
            key: 'failure',
            role: 'alert',
            style: { margin: '8px 0 0', fontSize: 12, color: 'var(--dsw-alias-state-error-primary)' },
          }, format(t('dialog.failed'), { reason: failure })))
        }
      }

      const done = result !== null && result.ok
      const footer = done
        ? [
          React.createElement(Button, {
            key: 'reload',
            variant: 'outline',
            onClick: () => { window.location.reload() },
          }, t('dialog.reloadNow')),
        ]
        : [
          React.createElement(Button, {
            key: 'cancel',
            variant: 'outline',
            disabled: busy,
            onClick: close,
          }, t('dialog.cancel')),
          React.createElement(Button, {
            key: 'confirm',
            disabled: busy || acknowledged !== true || plan === null || scanError !== null,
            style: {
              background: 'var(--dsw-alias-state-error-primary)',
              color: '#fff',
              borderColor: 'transparent',
            },
            onClick: confirm,
          }, busy ? t('dialog.deleting') : t('dialog.confirm')),
        ]

      return React.createElement(Modal, {
        open: true,
        onClose: close,
        title: t('dialog.title'),
        closeLabel: t('dialog.close'),
        description: format(t('dialog.subtitle'), { title }),
        footer: React.createElement(React.Fragment, null, footer),
      }, React.createElement('div', null, body))
    }

    /**
     * @param ctx - client plugin context.
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), `${NS}: dictionaries`)
      const purgeStore = createStore()

      ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
        name: 'sidebar.workspaces.session.menu.item',
        id: 'purge-session',
        // The shipped Archive row is order 400; 410 puts this row right after
        // it, before any plugin that appends at 500+.
        order: 410,
        locale: NS,
        inject: () => ({ purgeStore }),
      }, PurgeMenuItem))

      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'session-purge-dialog',
        locale: NS,
        inject: () => ({ purgeStore }),
      }, PurgeDialog))
    }

    return { name: NS, inject: ['slots', 'locale'], apply }
  },
})

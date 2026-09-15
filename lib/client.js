/**
 * dsh-preset-agent-manager — browser half.
 *
 * Hand-written bundle in the host's own module dialect: executing it only
 * registers the factory below, and no module body runs until the shell
 * materializes it. It requires nothing beyond the platform seed table
 * (`react`), talks to its own host half over the JSON route that half
 * registers, and owns no state outside this module.
 *
 * Surfaces:
 *  - `sidebar.footer.action` — the entry button at the sidebar foot.
 *  - `shell.overlay`         — the frame-wide panel, rendered only while open.
 */
window.__ModuleLoader__.load({
  id: 'dsh-preset-agent-manager',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    /** The host half's JSON route prefix. */
    const API = '/preset-agents-api'
    /** Availability vocabulary the host half reports per plugin row. */
    const UNAVAILABLE = new Set(['failed', 'broken', 'disabled', 'waiting', 'loading'])

    // ── module-scoped panel state ───────────────────────────────────────────
    // The button and the overlay are two independent slot registrations, so the
    // state they share lives here and subscribers re-render on every change.

    const listeners = new Set()
    const state = {
      open: false,
      loading: false,
      busy: false,
      error: '',
      notice: '',
      snapshot: null,
      editor: null,
      confirmDelete: null,
      unavailableAck: false,
      tab: 'agents',
    }

    /** Notify every mounted component. */
    function emit() {
      for (const listener of [...listeners]) listener()
    }

    /** Apply a partial state patch and re-render. */
    function set(patch) {
      Object.assign(state, patch)
      emit()
    }

    /** Subscribe one component to the panel state. */
    function usePanelState() {
      const [, force] = React.useState(0)
      React.useEffect(() => {
        const listener = () => force((count) => count + 1)
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      }, [])
      return state
    }

    // ── host API ────────────────────────────────────────────────────────────

    /**
     * Call one host route and fold its snapshot back into the panel state.
     * @param path - route below the API prefix.
     * @param body - JSON body for a POST, omitted for a GET.
     * @returns the decoded payload.
     */
    async function call(path, body) {
      const options = { headers: { accept: 'application/json' } }
      if (body !== undefined) {
        options.method = 'POST'
        options.headers['content-type'] = 'application/json'
        options.body = JSON.stringify(body)
      }
      const response = await fetch(`${API}${path}`, options)
      let payload = null
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
      if (!response.ok) throw new Error((payload && payload.error) || `HTTP ${response.status} ${response.statusText}`)
      if (payload && payload.ok === false) throw new Error(payload.error || 'the host rejected the request')
      return payload
    }

    /** Fold a state response into the panel snapshot. */
    function adopt(payload) {
      if (payload && payload.state !== undefined) {
        set({
          snapshot: {
            state: payload.state,
            plugins: payload.plugins ?? [],
            tools: payload.tools ?? [],
            providers: payload.providers ?? { available: false, names: [] },
            diagnostics: payload.diagnostics ?? [],
            statePath: payload.statePath ?? '',
          },
        })
      }
      return payload
    }

    /** Load the full panel snapshot. */
    async function refresh() {
      set({ loading: true, error: '' })
      try {
        adopt(await call('/state'))
      } catch (error) {
        set({ error: String((error && error.message) || error) })
      } finally {
        set({ loading: false })
      }
    }

    /** Run a mutating call with the busy flag and a friendly error surface. */
    async function mutate(path, body, notice) {
      set({ busy: true, error: '', notice: '' })
      try {
        adopt(await call(path, body))
        set({ notice: notice || '' })
        return true
      } catch (error) {
        set({ error: String((error && error.message) || error) })
        return false
      } finally {
        set({ busy: false })
      }
    }

    // ── small view helpers ──────────────────────────────────────────────────

    const COLORS = {
      panel: 'var(--dsw-alias-bg-layer-3, #1b1b1f)',
      sunken: 'var(--dsw-alias-bg-layer-1, #141417)',
      border: 'var(--dsw-alias-border-l2, #333)',
      strongBorder: 'var(--dsw-alias-border-l4, #4a4a4a)',
      text: 'var(--dsw-alias-label-primary, #eee)',
      muted: 'var(--dsw-alias-label-secondary, #aaa)',
      faint: 'var(--dsw-alias-label-tertiary, #888)',
      brand: 'var(--dsw-alias-brand-primary, #4d6bfe)',
      danger: 'var(--dsw-alias-label-error, #e5534b)',
    }

    /**
     * Panel stylesheet, registered once per document.
     *
     * Buttons are styled by class rather than inline styles on purpose: the host
     * ships global `button` rules that outrank an inline `background`, so a
     * transparent or brand-coloured control rendered as a plain white block.
     * `appearance`, `background` and `border` therefore carry `!important` here,
     * while everything layout-related stays inline. Colours are fixed rather
     * than themed so the controls stay legible in both host themes.
     */
    const STYLE_KEY = 'dsh-preset-agent-manager/panel.css'
    const PANEL_CSS = [
      'button.pam-btn{appearance:none!important;-webkit-appearance:none!important;background-image:none!important}',
      '.pam-btn.pam-btn{font:inherit;font-size:13px;line-height:20px;padding:5px 12px;border-radius:8px;cursor:pointer;color:inherit;background-color:rgba(127,127,127,.16)!important;border:1px solid rgba(127,127,127,.45)!important}',
      '.pam-btn.pam-btn:hover:not(:disabled){background-color:rgba(127,127,127,.28)!important}',
      '.pam-btn.pam-btn:disabled{opacity:.5;cursor:default}',
      '.pam-btn--primary.pam-btn--primary{background-color:#4d6bfe!important;border-color:#4d6bfe!important;color:#fff!important}',
      '.pam-btn--primary.pam-btn--primary:hover:not(:disabled){background-color:#3f5ae0!important}',
      '.pam-btn--danger.pam-btn--danger{background-color:rgba(229,83,75,.16)!important;border-color:rgba(229,83,75,.7)!important;color:#ff8f86!important}',
      '.pam-btn--danger.pam-btn--danger:hover:not(:disabled){background-color:rgba(229,83,75,.3)!important}',
      'button.pam-icon-btn{appearance:none!important;-webkit-appearance:none!important;background-image:none!important}',
      '.pam-icon-btn.pam-icon-btn{font:inherit;cursor:pointer;background-color:transparent!important;border:none!important;color:inherit}',
      'button.pam-chip{appearance:none!important;-webkit-appearance:none!important;background-image:none!important}',
      '.pam-chip.pam-chip{font:inherit;font-size:16px;line-height:20px;padding:2px 8px;border-radius:8px;cursor:pointer;background-color:transparent!important;border:1px solid rgba(127,127,127,.45)!important;color:inherit}',
    ].join('')

    /** Inject the panel stylesheet once per document. */
    function ensureStyles() {
      if (typeof document === 'undefined' || document.head === null) return
      if (document.querySelector('style[data-plugin-css="' + STYLE_KEY + '"]') !== null) return
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-preset-agent-manager'
      tag.dataset.pluginCss = STYLE_KEY
      tag.textContent = PANEL_CSS
      document.head.appendChild(tag)
    }

    /** A styled button; `kind` selects one of the class pairs above. */
    function Button(props) {
      const { children, onClick, kind = 'default', disabled, title, style } = props
      const className =
        kind === 'primary' ? 'pam-btn pam-btn--primary' : kind === 'danger' ? 'pam-btn pam-btn--danger' : 'pam-btn'
      return h(
        'button',
        {
          type: 'button',
          title,
          className,
          disabled: disabled === true,
          onClick,
          style: style || undefined,
        },
        children,
      )
    }

    /** A labelled text input. */
    function Field(props) {
      const { label, value, onChange, placeholder, hint, multiline, mono } = props
      const shared = {
        width: '100%',
        boxSizing: 'border-box',
        font: 'inherit',
        fontSize: 13,
        lineHeight: '20px',
        color: COLORS.text,
        background: COLORS.sunken,
        border: `1px solid ${COLORS.strongBorder}`,
        borderRadius: 8,
        padding: '6px 10px',
        fontFamily: mono === true ? 'ui-monospace, SFMono-Regular, Menlo, monospace' : 'inherit',
      }
      return h(
        'label',
        { style: { display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 10 } },
        h('span', { style: { fontSize: 12, color: COLORS.muted } }, label),
        multiline === true
          ? h('textarea', {
              value,
              placeholder,
              rows: 4,
              onChange: (event) => onChange(event.target.value),
              style: { ...shared, resize: 'vertical' },
            })
          : h('input', {
              value,
              placeholder,
              onChange: (event) => onChange(event.target.value),
              style: shared,
            }),
        hint ? h('span', { style: { fontSize: 11, color: COLORS.faint } }, hint) : null,
      )
    }

    /** A small pill. */
    function Pill(props) {
      const color = props.tone === 'danger' ? COLORS.danger : props.tone === 'brand' ? COLORS.brand : COLORS.muted
      return h(
        'span',
        {
          style: {
            display: 'inline-block',
            fontSize: 11,
            lineHeight: '16px',
            padding: '1px 7px',
            borderRadius: 999,
            border: `1px solid ${color}`,
            color,
            whiteSpace: 'nowrap',
          },
        },
        props.children,
      )
    }

    // ── the sidebar entry ───────────────────────────────────────────────────

    /**
     * Sidebar-foot entry. The owning sidebar passes `{ wide }`; the panel opens
     * as an overlay so this stays a single compact control in the rail too.
     */
    function LaunchButton() {
      const current = usePanelState()
      return h(
        'button',
        {
          type: 'button',
          title: '预设智能体管理',
          'aria-label': '预设智能体管理',
          'aria-expanded': current.open,
          onClick: () => {
            const next = !state.open
            set({ open: next, confirmDelete: null, editor: null, unavailableAck: false })
            if (next && state.snapshot === null) refresh()
          },
          style: {
            fontSize: 13,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            width: '100%',
            padding: '6px 8px',
            borderRadius: 8,
            textAlign: 'left',
            color: current.open ? COLORS.brand : COLORS.text,
          },
          className: 'pam-icon-btn',
        },
        h('span', { 'aria-hidden': 'true', style: { fontSize: 15, lineHeight: '18px' } }, '⚉'),
        h('span', null, '预设智能体'),
      )
    }

    // ── editor ──────────────────────────────────────────────────────────────

    /** Begin a new-agent draft. */
    function startCreate() {
      set({
        editor: {
          mode: 'create',
          id: '',
          name: '',
          description: '',
          persona: '',
          plugins: [],
          tools: [],
        },
        unavailableAck: false,
        error: '',
        notice: '',
      })
    }

    /** Begin an edit draft from one stored agent. */
    function startEdit(agent) {
      set({
        editor: {
          mode: 'edit',
          id: agent.id,
          name: agent.name,
          description: agent.description,
          persona: agent.persona,
          plugins: [...(agent.pluginWhitelist || [])],
          tools: [...(agent.toolWhitelist || [])],
        },
        unavailableAck: false,
        error: '',
        notice: '',
      })
    }

    /** Toggle one value inside a draft list field. */
    function toggleDraft(field, value) {
      const editor = state.editor
      if (editor === null) return
      const list = editor[field]
      const next = list.includes(value) ? list.filter((item) => item !== value) : [...list, value]
      set({ editor: { ...editor, [field]: next } })
    }

    /** Patch one draft scalar field. */
    function patchDraft(patch) {
      if (state.editor === null) return
      set({ editor: { ...state.editor, ...patch } })
    }

    /** Plugin rows the current draft selects that this profile cannot serve. */
    function draftUnavailable() {
      const editor = state.editor
      const snapshot = state.snapshot
      if (editor === null || snapshot === null) return []
      return snapshot.plugins.filter((plugin) => editor.plugins.includes(plugin.moduleName) && UNAVAILABLE.has(plugin.availability))
    }

    /** Persist the current draft. */
    async function saveDraft() {
      const editor = state.editor
      if (editor === null) return
      const id = editor.id.trim()
      if (id === '') {
        set({ error: 'id 不能为空' })
        return
      }
      if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
        set({ error: 'id 只能包含小写字母、数字与连字符，且不能以连字符开头' })
        return
      }
      const unavailable = draftUnavailable()
      if (unavailable.length > 0 && !state.unavailableAck) {
        set({ error: '所选插件中存在不可用项，请先确认' })
        return
      }
      const ok = await mutate(
        '/agents',
        {
          id,
          name: editor.name,
          description: editor.description,
          persona: editor.persona,
          pluginWhitelist: editor.plugins,
          toolWhitelist: editor.tools,
        },
        `已保存预设智能体「${editor.name || id}」`,
      )
      if (ok) set({ editor: null, unavailableAck: false })
    }

    /** The plugin picker: every installed row with its live availability. */
    function PluginPicker() {
      const snapshot = state.snapshot
      if (snapshot === null) return null
      const editor = state.editor
      const query = state.pluginQuery || ''
      const rows = snapshot.plugins.filter((plugin) => {
        if (query === '') return true
        const needle = query.toLowerCase()
        return plugin.moduleName.toLowerCase().includes(needle) || (plugin.displayName || '').toLowerCase().includes(needle)
      })
      return h(
        'div',
        { style: { marginBottom: 12 } },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 } },
          h('span', { style: { fontSize: 12, color: COLORS.muted } }, `插件白名单（已安装 ${snapshot.plugins.length} 行）`),
          h('input', {
            value: query,
            placeholder: '过滤…',
            onChange: (event) => set({ pluginQuery: event.target.value }),
            style: {
              marginLeft: 'auto',
              width: 180,
              font: 'inherit',
              fontSize: 12,
              color: COLORS.text,
              background: COLORS.sunken,
              border: `1px solid ${COLORS.strongBorder}`,
              borderRadius: 6,
              padding: '3px 8px',
            },
          }),
        ),
        h(
          'div',
          {
            style: {
              maxHeight: 220,
              overflowY: 'auto',
              border: `1px solid ${COLORS.border}`,
              borderRadius: 8,
              background: COLORS.sunken,
            },
          },
          rows.length === 0
            ? h('div', { style: { padding: 10, fontSize: 12, color: COLORS.faint } }, '没有匹配的插件行')
            : rows.map((plugin) => {
                const checked = editor.plugins.includes(plugin.moduleName)
                const unavailable = UNAVAILABLE.has(plugin.availability)
                return h(
                  'label',
                  {
                    key: plugin.moduleName,
                    style: {
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: 8,
                      padding: '6px 10px',
                      borderBottom: `1px solid ${COLORS.border}`,
                      cursor: 'pointer',
                    },
                  },
                  h('input', {
                    type: 'checkbox',
                    checked,
                    onChange: () => toggleDraft('plugins', plugin.moduleName),
                    style: { marginTop: 3 },
                  }),
                  h(
                    'span',
                    { style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 } },
                    h(
                      'span',
                      { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
                      h('span', { style: { fontSize: 12.5, color: COLORS.text } }, plugin.displayName || plugin.moduleName),
                      h(Pill, { tone: unavailable ? 'danger' : 'default' }, plugin.availability),
                      plugin.entryIds && plugin.entryIds.length > 0 ? h(Pill, null, plugin.entryIds[0]) : null,
                      plugin.presets && plugin.presets.length > 0 ? h(Pill, null, plugin.presets.join('/')) : null,
                    ),
                    h('span', { style: { fontSize: 11, color: COLORS.faint, wordBreak: 'break-all' } }, plugin.moduleName),
                    plugin.reason ? h('span', { style: { fontSize: 11, color: COLORS.danger } }, plugin.reason) : null,
                  ),
                )
              }),
        ),
      )
    }

    /** The tool picker: the strict whitelist that actually reaches the child. */
    function ToolPicker() {
      const snapshot = state.snapshot
      if (snapshot === null) return null
      const editor = state.editor
      const query = state.toolQuery || ''
      const rows = snapshot.tools.filter((tool) => query === '' || tool.name.toLowerCase().includes(query.toLowerCase()))
      return h(
        'div',
        { style: { marginBottom: 12 } },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 } },
          h(
            'span',
            { style: { fontSize: 12, color: COLORS.muted } },
            `工具白名单（严格生效，共 ${snapshot.tools.length} 个）`,
          ),
          h('input', {
            value: query,
            placeholder: '过滤…',
            onChange: (event) => set({ toolQuery: event.target.value }),
            style: {
              marginLeft: 'auto',
              width: 180,
              font: 'inherit',
              fontSize: 12,
              color: COLORS.text,
              background: COLORS.sunken,
              border: `1px solid ${COLORS.strongBorder}`,
              borderRadius: 6,
              padding: '3px 8px',
            },
          }),
        ),
        h(
          'div',
          {
            style: {
              maxHeight: 200,
              overflowY: 'auto',
              border: `1px solid ${COLORS.border}`,
              borderRadius: 8,
              background: COLORS.sunken,
              padding: '6px 10px',
              display: 'flex',
              flexWrap: 'wrap',
              gap: 6,
            },
          },
          rows.length === 0
            ? h('span', { style: { fontSize: 12, color: COLORS.faint } }, '没有可用工具')
            : rows.map((tool) => {
                const grantable = tool.whitelistable !== false
                const checked = grantable && editor.tools.includes(tool.name)
                return h(
                  'label',
                  {
                    key: tool.name,
                    title: grantable
                      ? `${tool.description || ''}\n作用域: ${(tool.scopes || []).join(', ')}`
                      : `${tool.description || ''}\n该工具由 agent preset 行注册（作用域: ${(tool.scopes || []).join(
                          ', ',
                        )}），不在全局工具层，因此无法通过白名单授予任何预设智能体。`,
                    style: {
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 4,
                      fontSize: 12,
                      padding: '2px 8px',
                      borderRadius: 999,
                      cursor: grantable ? 'pointer' : 'not-allowed',
                      opacity: grantable ? 1 : 0.45,
                      color: checked ? COLORS.brand : COLORS.muted,
                      border: `1px solid ${checked ? COLORS.brand : COLORS.strongBorder}`,
                    },
                  },
                  h('input', {
                    type: 'checkbox',
                    checked,
                    disabled: !grantable,
                    onChange: () => toggleDraft('tools', tool.name),
                    style: { margin: 0 },
                  }),
                  tool.name,
                )
              }),
          h(
            'div',
            { style: { fontSize: 11, color: COLORS.faint, marginTop: 2 } },
            '清单来自本 profile 各 preset 组合的并集。真正生效的范围是严格白名单：未勾选的工具在子会话里既不可见也无法调用；若某个名字在当前主会话的组合中不存在，委派时会被自动剔除并写入返回结果的 warnings。',
          ),
        ),
      )
    }

    /**
     * The create/edit form. It takes over the panel instead of floating inside
     * it: the panel already adapts to the viewport, so a nested dialog would
     * shrink the form twice over and force a second scrollbar. The two columns
     * are flex items with a basis, so a narrow window stacks them by itself —
     * inline styles cannot express a media query, and none is needed.
     */
    function Editor() {
      const current = usePanelState()
      const editor = current.editor
      if (editor === null) return null
      const snapshot = current.snapshot
      const unavailable = draftUnavailable()
      return h(
        'div',
        {
          style: {
            position: 'absolute',
            inset: 0,
            background: COLORS.panel,
            display: 'flex',
            flexDirection: 'column',
            minHeight: 0,
          },
        },
        h(
          'div',
          {
            style: {
              flex: 'none',
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '14px 18px',
              borderBottom: `1px solid ${COLORS.border}`,
            },
          },
          h(
            'span',
            { style: { fontSize: 15, fontWeight: 600 } },
            editor.mode === 'create' ? '新建预设智能体' : `编辑「${editor.name || editor.id}」`,
          ),
          h('span', { style: { fontSize: 11.5, color: COLORS.faint } }, 'id 是 preset_agent_dispatch 的调用键'),
          h(
            Button,
            { style: { marginLeft: 'auto' }, disabled: current.busy, onClick: () => set({ editor: null }) },
            '返回列表',
          ),
        ),
        h(
          'div',
          { style: { flex: 1, minHeight: 0, overflowY: 'auto', padding: '16px 18px' } },
          h(
            'div',
            { style: { display: 'flex', gap: 20, flexWrap: 'wrap', alignItems: 'flex-start' } },
            h(
              'div',
              { style: { flex: '1 1 340px', minWidth: 0 } },
              h(Field, {
                label: 'id（唯一标识，小写字母/数字/连字符）',
                value: editor.id,
                mono: true,
                placeholder: 'log-tracer',
                hint:
                  editor.mode === 'edit'
                    ? 'id 是主智能体调用 preset_agent_dispatch 时使用的键，修改后请同步更新说明。'
                    : '创建后不建议修改。',
                onChange: (value) => patchDraft({ id: value }),
              }),
              h(Field, {
                label: '名称',
                value: editor.name,
                placeholder: '日志追踪器',
                onChange: (value) => patchDraft({ name: value }),
              }),
              h(Field, {
                label: '描述（触发域，主智能体据此自主判断是否委派）',
                value: editor.description,
                multiline: true,
                placeholder: '排查日志、慢查询、错误堆栈',
                onChange: (value) => patchDraft({ description: value }),
              }),
              h(Field, {
                label: 'persona 提示词',
                value: editor.persona,
                multiline: true,
                placeholder: '你是一个专业的日志分析专家……',
                hint: '仅注入该预设智能体的子会话，覆盖部署默认 persona。',
                onChange: (value) => patchDraft({ persona: value }),
              }),
            ),
            h(
              'div',
              { style: { flex: '1 1 420px', minWidth: 0 } },
              h(PluginPicker),
              h(ToolPicker),
            ),
          ),
          unavailable.length > 0
            ? h(
                'div',
                {
                  style: {
                    border: `1px solid ${COLORS.danger}`,
                    borderRadius: 8,
                    padding: '8px 10px',
                    marginTop: 12,
                    fontSize: 12,
                    color: COLORS.danger,
                  },
                },
                h('div', null, `以下插件不可用：${unavailable.map((plugin) => plugin.moduleName).join('、')}`),
                h(
                  'label',
                  { style: { display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, color: COLORS.text } },
                  h('input', {
                    type: 'checkbox',
                    checked: current.unavailableAck,
                    onChange: (event) => set({ unavailableAck: event.target.checked }),
                  }),
                  '我已知晓，仍要保存（运行时这些插件不会注入）',
                ),
              )
            : null,
        ),
        h(
          'div',
          {
            style: {
              flex: 'none',
              display: 'flex',
              gap: 8,
              alignItems: 'center',
              padding: '12px 18px',
              borderTop: `1px solid ${COLORS.border}`,
            },
          },
          h(Button, { kind: 'primary', disabled: current.busy, onClick: saveDraft }, current.busy ? '保存中…' : '保存'),
          h(Button, { disabled: current.busy, onClick: () => set({ editor: null }) }, '取消'),
          snapshot !== null
            ? h(
                'span',
                { style: { marginLeft: 'auto', fontSize: 11, color: COLORS.faint } },
                `已选插件 ${editor.plugins.length} · 已选工具 ${editor.tools.length}`,
              )
            : null,
        ),
      )
    }

    // ── agent list ──────────────────────────────────────────────────────────

    /** One stored agent card. */
    function AgentCard(props) {
      const current = usePanelState()
      const agent = props.agent
      const snapshot = current.snapshot
      const confirming = current.confirmDelete === agent.id
      const pluginNames = agent.pluginWhitelist || []
      const toolNames = agent.toolWhitelist || []
      const unavailable = snapshot === null ? [] : snapshot.plugins.filter((plugin) => pluginNames.includes(plugin.moduleName) && UNAVAILABLE.has(plugin.availability))
      return h(
        'div',
        {
          style: {
            border: `1px solid ${COLORS.border}`,
            borderRadius: 10,
            padding: '12px 14px',
            marginBottom: 10,
            background: COLORS.sunken,
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          },
        },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
          h('span', { style: { fontSize: 14, fontWeight: 600 } }, agent.name || agent.id),
          h('code', { style: { fontSize: 12, color: COLORS.muted } }, agent.id),
          unavailable.length > 0 ? h(Pill, { tone: 'danger' }, `${unavailable.length} 个插件不可用`) : null,
        ),
        agent.description ? h('div', { style: { fontSize: 12.5, color: COLORS.muted } }, agent.description) : null,
        h(
          'div',
          { style: { fontSize: 11.5, color: COLORS.faint, display: 'flex', flexDirection: 'column', gap: 2 } },
          h('span', null, `插件：${pluginNames.length === 0 ? '（未选择）' : pluginNames.join('、')}`),
          h('span', null, `工具：${toolNames.length === 0 ? '（无，子会话不能调用任何工具）' : toolNames.join('、')}`),
        ),
        h(
          'div',
          { style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 4, flexWrap: 'wrap' } },
          h(Button, { onClick: () => startEdit(agent) }, '编辑'),
          confirming
            ? h(
                'span',
                { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
                h(
                  'span',
                  { style: { fontSize: 12, color: COLORS.danger } },
                  `确认删除？正在运行的委派实例不会被中断，会在自身结束后释放。（当前活跃子会话：${
                    current.runningChildren === null || current.runningChildren === undefined
                      ? '未知'
                      : current.runningChildren
                  }）`,
                ),
                h(
                  Button,
                  {
                    kind: 'danger',
                    disabled: current.busy,
                    onClick: async () => {
                      set({ busy: true, error: '', notice: '' })
                      try {
                        const payload = await call('/agents/delete', { id: agent.id })
                        adopt(payload)
                        const running = Array.isArray(payload.runningChildren) ? payload.runningChildren.length : 0
                        set({
                          confirmDelete: null,
                          notice:
                            running === 0
                              ? `已删除「${agent.name || agent.id}」`
                              : `已删除「${agent.name || agent.id}」；${running} 个正在运行的委派实例会自行结束`,
                        })
                      } catch (error) {
                        set({ error: String((error && error.message) || error) })
                      } finally {
                        set({ busy: false })
                      }
                    },
                  },
                  '确认删除',
                ),
                h(Button, { onClick: () => set({ confirmDelete: null }) }, '取消'),
              )
            : h(Button, { kind: 'danger', onClick: () => set({ confirmDelete: agent.id }) }, '删除'),
        ),
      )
    }

    /** The panel body. */
    function PanelBody() {
      const current = usePanelState()
      const snapshot = current.snapshot
      if (current.loading && snapshot === null) return h('div', { style: { padding: 20, color: COLORS.muted } }, '正在读取预设智能体…')
      if (snapshot === null) {
        return h(
          'div',
          { style: { padding: 20 } },
          h('div', { style: { color: COLORS.danger, marginBottom: 10 } }, current.error || '无法读取预设智能体数据'),
          h(Button, { onClick: refresh }, '重试'),
        )
      }
      const agents = snapshot.state.agents || []
      return h(
        'div',
        { style: { padding: '0 0 8px' } },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '0 0 12px', flexWrap: 'wrap' } },
          h(Button, { kind: 'primary', onClick: startCreate }, '＋ 新建预设智能体'),
          h(Button, { disabled: current.loading, onClick: refresh }, '刷新'),
        ),
        current.notice ? h('div', { style: { fontSize: 12, color: COLORS.brand, marginBottom: 10 } }, current.notice) : null,
        current.error ? h('div', { style: { fontSize: 12, color: COLORS.danger, marginBottom: 10 } }, current.error) : null,
        agents.length === 0
          ? h(
              'div',
              {
                style: {
                  border: `1px dashed ${COLORS.border}`,
                  borderRadius: 10,
                  padding: '28px 16px',
                  textAlign: 'center',
                  color: COLORS.faint,
                  fontSize: 13,
                },
              },
              '暂无预设智能体',
              h('div', { style: { fontSize: 11.5, marginTop: 6 } }, '点击「新建预设智能体」创建第一个；创建后主智能体即可通过 preset_agent_dispatch 调用它。'),
            )
          : agents.map((agent) => h(AgentCard, { key: agent.id, agent })),
        h(
          'div',
          { style: { marginTop: 14, fontSize: 11, color: COLORS.faint, display: 'flex', flexDirection: 'column', gap: 2 } },
          h('span', null, `存储：${snapshot.statePath}`),
          h('span', null, `委派 provider：${snapshot.providers.available ? snapshot.providers.names.join(', ') || '（无）' : '不可用'}`),
          ...(snapshot.diagnostics || []).map((line, index) => h('span', { key: `diag-${index}` }, `诊断：${line}`)),
        ),
      )
    }

    // ── overlay shell ───────────────────────────────────────────────────────

    /** The frame-wide panel; renders nothing while closed. */
    function Panel() {
      const current = usePanelState()
      React.useEffect(() => {
        if (!current.open) return undefined
        const onKey = (event) => {
          if (event.key !== 'Escape') return
          if (state.editor !== null) set({ editor: null })
          else set({ open: false })
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [current.open])

      if (!current.open) return null
      return h(
        'div',
        {
          style: {
            position: 'fixed',
            inset: 0,
            zIndex: 60,
            background: 'rgba(0,0,0,0.35)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 20,
          },
          onClick: () => set({ open: false }),
        },
        h(
          'div',
          {
            onClick: (event) => event.stopPropagation(),
            style: {
              position: 'relative',
              // Viewport-relative, not a fixed card: the panel is the working
              // surface for the registry, so it takes whatever the page can
              // spare and tracks resizes by itself. The 40px reserve is the
              // overlay padding on both sides, kept out of the calc so the panel
              // never overflows a small window.
              width: 'min(1440px, calc(100vw - 40px))',
              height: 'min(940px, calc(100vh - 40px))',
              minHeight: 0,
              display: 'flex',
              flexDirection: 'column',
              background: COLORS.panel,
              color: COLORS.text,
              border: `1px solid ${COLORS.border}`,
              borderRadius: 14,
              boxShadow: '0 24px 80px rgba(0,0,0,0.5)',
              overflow: 'hidden',
            },
          },
          h(
            'div',
            {
              style: {
                flex: 'none',
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '14px 18px',
                borderBottom: `1px solid ${COLORS.border}`,
              },
            },
            h('span', { style: { fontSize: 15, fontWeight: 600 } }, '预设智能体管理'),
            h('span', { style: { fontSize: 11.5, color: COLORS.faint } }, '主智能体可通过 preset_agent_dispatch 自主委派'),
            h(
              'button',
              {
                type: 'button',
                onClick: () => set({ open: false }),
                'aria-label': '关闭',
                className: 'pam-chip',
                style: {
                  marginLeft: 'auto',
                  color: COLORS.muted,
                },
              },
              '✕',
            ),
          ),
          h('div', { style: { flex: 1, minHeight: 0, overflowY: 'auto', padding: '14px 18px' } }, h(PanelBody)),
          h(Editor),
        ),
      )
    }

    // ── plugin body ─────────────────────────────────────────────────────────

    /** Required service: the UI slot registry. */
    const inject = ['slots']

    /**
     * Fill the sidebar entry and the frame overlay as one registration set.
     * @param ctx - client root context.
     */
    function apply(ctx) {
      // The controls are styled from one document-level stylesheet; see PANEL_CSS
      // for why a class beats an inline background under the host's own rules.
      ensureStyles()

      ctx.slots.inject('sidebar.footer.action', () =>
        ctx.slots.inject('shell.overlay', function* () {
          yield ctx.slots.register({ name: 'sidebar.footer.action', id: 'preset-agents', order: 50, label: '预设智能体' }, LaunchButton)
          yield ctx.slots.register({ name: 'shell.overlay', id: 'preset-agents', order: 50, label: '预设智能体' }, Panel)
        }),
      )
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})

/**
 * dsh-preset-agent-manager — Host implementation.
 *
 * Loaded by `lib/index.js`, which is a thin, rarely-changed shell so a
 * deployment can roll the implementation forward without restarting the
 * profile (see that file for the `rev` contract).
 *
 * Owns three things:
 *  1. the durable preset-agent registry (`$DSH_HOME/data/dsh-preset-agent-manager/agents.json`),
 *  2. the model-facing `preset_agent_dispatch` / `preset_agent_admin` tools,
 *  3. the small JSON HTTP surface the browser half reads and writes.
 *
 * Delegation goes through `ctx.subagents.start()` — the harness's own
 * named-provider seam — so every dispatch is an ordinary child Agent with its
 * own session, its own scope, and a `maxDepth` cap of 1 that makes nested
 * delegation impossible. The per-agent plugin whitelist is applied as a strict
 * `toolFilter.allow` inside the child's creation window: a tool outside the
 * whitelist is absent from the child's prompt AND refuses to execute.
 *
 * @module dsh-preset-agent-manager/impl
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'

/** Browser-facing JSON prefix; the client half fetches under this path. */
const API_PREFIX = '/preset-agents-api'
/** Agent ids are stable identifiers and follow the composition-safe grammar. */
const AGENT_ID_RE = /^[a-z0-9][a-z0-9-]*$/
/** Body cap for the admin API. */
const MAX_BODY_BYTES = 2 * 1024 * 1024
/** Delegation status vocabulary returned to the calling model. */
const STATUS = Object.freeze({ success: 'success', partial: 'partial', failed: 'failed' })
/** Cordis FiberState mirror (a cross-package const enum without a runtime object). */
const FIBER_STATE = Object.freeze({
  0: 'pending',
  1: 'loading',
  2: 'active',
  3: 'failed',
  4: null,
  5: 'unloading',
})

/**
 * Child session ids reported by `subagent/start` and not yet claimed by the
 * dispatch that started them. That event fires while `subagents.start()` is
 * still on the stack, so the dispatch learns its child's id only after the
 * fact; this set is what lets it find the child again without guessing, and
 * without a race between two concurrent dispatches.
 */
const pendingChildren = new Set()

// ── durable state ───────────────────────────────────────────────────────────

/** Absolute directory holding this plugin's durable data. */
function dataDirectory() {
  const configured = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  const home = configured === '' ? path.join(homedir(), '.dsh') : configured
  return path.join(home, 'data', 'dsh-preset-agent-manager')
}

/** Absolute path of the registry document required by this plugin's contract. */
export function stateFilePath() {
  return path.join(dataDirectory(), 'agents.json')
}

/** Append one line to this plugin's boot trace, never throwing. */
function trace(line) {
  try {
    const directory = dataDirectory()
    mkdirSync(directory, { recursive: true })
    appendFileSync(path.join(directory, 'boot.log'), `${new Date().toISOString()} impl: ${line}\n`)
  } catch {
    // Diagnostics must never be the reason a plugin fails to load.
  }
}

/** The registry served before the first write. */
function emptyState() {
  return { version: 1, agents: [] }
}

/** Coerce one string field, trimmed, with a fallback. */
function text(value, fallback = '') {
  return typeof value === 'string' ? value.trim() : fallback
}

/** Normalize a string list: trimmed, non-empty, de-duplicated, order preserved. */
function stringList(value) {
  if (!Array.isArray(value)) return []
  const seen = new Set()
  const out = []
  for (const entry of value) {
    const item = text(entry)
    if (item === '' || seen.has(item)) continue
    seen.add(item)
    out.push(item)
  }
  return out
}

/**
 * Normalize one stored agent into the shape the panel and the dispatcher share.
 * Unknown fields are dropped, so a hand-edited document cannot smuggle state
 * into the runtime.
 * @param input - candidate record from disk or from the admin API.
 * @param previous - existing record when this is an update, for createdAt.
 * @returns the normalized record.
 * @throws {Error} when the id is missing or outside {@link AGENT_ID_RE}.
 */
function normalizeAgent(input, previous) {
  const id = text(input?.id)
  if (id === '') throw new Error('preset agent: `id` is required')
  if (!AGENT_ID_RE.test(id)) {
    throw new Error(`preset agent: id "${id}" must match ${AGENT_ID_RE} (lowercase letters, digits and dashes, no leading dash)`)
  }
  const now = new Date().toISOString()
  return {
    id,
    name: text(input?.name) || id,
    description: text(input?.description),
    persona: text(input?.persona),
    pluginWhitelist: stringList(input?.pluginWhitelist),
    toolWhitelist: stringList(input?.toolWhitelist),
    createdAt: text(previous?.createdAt) || text(input?.createdAt) || now,
    updatedAt: now,
  }
}

/** Normalize a whole document read from disk. */
function normalizeState(raw) {
  const state = emptyState()
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return state
  const agents = Array.isArray(raw.agents) ? raw.agents : []
  for (const candidate of agents) {
    try {
      state.agents.push(normalizeAgent(candidate))
    } catch {
      // A single malformed record must not take the whole registry down.
    }
  }
  return state
}

/**
 * Serialized, atomic access to the registry document. Writes go through a
 * temporary file plus rename so a crash mid-write cannot truncate the file the
 * next boot reads.
 */
class Registry {
  /** @param ctx - owning Cordis context, used only for diagnostics. */
  constructor(ctx) {
    this.ctx = ctx
    this.chain = Promise.resolve()
    this.warning = undefined
  }

  /** Warn once per distinct read problem. */
  #warn(message) {
    if (this.warning === message) return
    this.warning = message
    this.ctx?.logger?.warn?.(`preset-agent-manager: ${message}`)
  }

  /**
   * Read the current document. A missing file is the empty registry; an
   * unreadable or malformed one is reported without being destroyed.
   * @returns the normalized document.
   */
  async read() {
    let raw
    try {
      raw = await readFile(stateFilePath(), 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return emptyState()
      this.#warn(`cannot read ${stateFilePath()}: ${error?.message ?? error}`)
      return emptyState()
    }
    try {
      return normalizeState(JSON.parse(raw))
    } catch (error) {
      const backup = `${stateFilePath()}.corrupt-${Date.now()}`
      try {
        await rename(stateFilePath(), backup)
        this.#warn(`registry was not valid JSON; moved to ${backup}`)
      } catch {
        this.#warn(`registry is not valid JSON and could not be moved aside: ${error?.message ?? error}`)
      }
      return emptyState()
    }
  }

  /** Persist one document atomically. */
  async write(state) {
    await mkdir(dataDirectory(), { recursive: true })
    const temporary = `${stateFilePath()}.tmp`
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
    await rename(temporary, stateFilePath())
  }

  /**
   * Run one read-modify-write transaction. Concurrent callers serialize, so two
   * panel saves cannot interleave into a lost update.
   * @param mutate - receives the current document and returns the value to publish.
   * @returns the value returned by `mutate`.
   */
  async transaction(mutate) {
    const run = this.chain.then(async () => {
      const state = await this.read()
      const outcome = await mutate(state)
      if (outcome?.skipWrite !== true) await this.write(state)
      return outcome?.value
    })
    this.chain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }
}

// ── live inventory ──────────────────────────────────────────────────────────

/** Text of a model-facing content block list, ignoring non-text blocks. */
function contentText(blocks) {
  if (!Array.isArray(blocks)) return ''
  const parts = []
  for (const block of blocks) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    } else if (block !== null && typeof block === 'object' && block.type === 'image') {
      parts.push('[image]')
    }
  }
  return parts.join('\n').trim()
}

/**
 * Tool schemas visible in one scope.
 *
 * `ctx.tools.schemas(scope)` is the registry's own visibility resolver, so a
 * name that comes back from it is exactly a name the model in that scope can
 * call. Calling it with no scope reads the process-global layer only, which is
 * why every whitelist check below resolves a preset scope first: a preset's
 * plugin rows register their tools in that mount's scope, not globally.
 * @param ctx - host context.
 * @param scopeKey - a ScopeKey, or undefined for the global layer.
 * @returns the visible tool schemas.
 */
function toolSchemasIn(ctx, scopeKey) {
  try {
    if (scopeKey === undefined) return ctx.tools?.schemas?.() ?? []
    return ctx.tools?.schemas?.(scopeKey) ?? []
  } catch {
    return []
  }
}

/**
 * ScopeKey of one preset's standing mount, or undefined when the roster is not
 * mounted or the preset cannot compose. `standingKeyFor` is the roster's own
 * single-flight resolver; it composes the preset but starts no agent.
 * @param ctx - host context.
 * @param presetId - preset id, or undefined for the deployment default.
 * @returns the mount's scope key.
 */
async function scopeKeyForPreset(ctx, presetId) {
  const presets = ctx.get('agentPresets')
  if (presets === undefined) return undefined
  try {
    return await presets.standingKeyFor(presetId)
  } catch {
    return undefined
  }
}

/** Turn a schema list into sorted, de-duplicated `{name, description}` rows. */
function toolRows(schemas) {
  const byName = new Map()
  for (const schema of schemas) {
    if (typeof schema?.name !== 'string' || schema.name === '') continue
    if (byName.has(schema.name)) continue
    byName.set(schema.name, {
      name: schema.name,
      description: typeof schema.description === 'string' ? schema.description : '',
    })
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Panel-facing tool inventory: the union of the process-global view and every
 * preset mount's view, each row carrying the scopes that expose it.
 * @param ctx - host context.
 * @returns tool rows sorted by name.
 */
async function toolInventory(ctx) {
  const byName = new Map()
  const collect = (schemas, scope) => {
    for (const row of toolRows(schemas)) {
      const existing = byName.get(row.name)
      if (existing === undefined) byName.set(row.name, { ...row, scopes: [scope] })
      else if (!existing.scopes.includes(scope)) existing.scopes.push(scope)
    }
  }
  collect(toolSchemasIn(ctx, undefined), 'global')

  const presets = ctx.get('agentPresets')
  if (presets !== undefined) {
    let roster = []
    try {
      roster = await presets.list()
    } catch {
      roster = []
    }
    for (const preset of roster) {
      const key = await scopeKeyForPreset(ctx, preset.id)
      if (key === undefined) continue
      collect(toolSchemasIn(ctx, key), `preset:${preset.id}`)
    }
  }
  return { rows: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)), diagnostics: [] }
}

/**
 * Names a whitelist may grant for one delegating parent.
 *
 * `tools.restrict()` validates against what the calling scope INHERITS — the
 * host-plane rows plus every ancestor layer on the parent's chain — and rejects
 * any other name outright. Reading the process-global view instead would drop
 * nearly every real tool, because a host plugin row registers into its own
 * scope rather than the root scope. The parent's own context is therefore the
 * only faithful source, and it is also exactly the set the child will inherit.
 * @param parent - the delegating parent agent.
 * @returns the grantable name set.
 */
function grantableToolNames(parent) {
  try {
    return new Set(toolRows(parent.ctx.tools.schemas()).map((row) => row.name))
  } catch {
    return new Set()
  }
}

/** Loader rows plus each preset's composition rows, as this profile sees them. */
async function pluginInventory(ctx) {
  const rows = []
  const diagnostics = []
  const loader = ctx.get('loader')
  if (loader === undefined) {
    diagnostics.push('the Cordis Loader service is not mounted, so installed plugin rows cannot be listed')
  } else {
    try {
      for (const entry of loader.entries()) {
        if (entry.options?.group === true) continue
        rows.push({
          entryId: typeof entry.id === 'string' ? entry.id : null,
          moduleName: typeof entry.options?.name === 'string' ? entry.options.name : '',
          enabled: entry.disabled !== true,
          fiberPhase: entry.fiber === undefined ? null : (FIBER_STATE[entry.fiber.state] ?? null),
          inject: Array.isArray(entry.options?.inject) ? entry.options.inject : [],
          scope: 'host',
        })
      }
    } catch (error) {
      diagnostics.push(`reading Loader entries failed: ${error?.message ?? error}`)
    }
  }

  const presets = ctx.get('agentPresets')
  const presetRows = []
  if (presets === undefined) {
    diagnostics.push('the agent-preset roster is not mounted, so preset plugin rows cannot be listed')
  } else {
    try {
      const composition = await presets.compositionInventory()
      for (const preset of composition) {
        for (const row of preset.rows ?? []) {
          presetRows.push({
            entryId: row.entryId ?? null,
            moduleName: row.moduleName ?? '',
            enabled: row.enabled === true,
            conditional: row.enabled === 'conditional',
            fiberPhase: row.fiberState === undefined ? null : (FIBER_STATE[row.fiberState] ?? null),
            inject: [],
            scope: `preset:${preset.id}`,
            presetId: preset.id,
            presetName: preset.name ?? preset.id,
            presetTrust: preset.trust,
            broken: preset.broken,
          })
        }
      }
    } catch (error) {
      diagnostics.push(`reading preset compositions failed: ${error?.message ?? error}`)
    }
  }

  // A module named by several rows is one install: collapse to the strongest state.
  const byModule = new Map()
  for (const row of [...rows, ...presetRows]) {
    const key = row.moduleName
    if (key === '') continue
    const existing = byModule.get(key)
    if (existing === undefined) {
      byModule.set(key, {
        moduleName: key,
        entryIds: row.entryId === null ? [] : [row.entryId],
        scopes: [row.scope],
        presets: row.presetId === undefined ? [] : [row.presetId],
        inject: row.inject ?? [],
        enabled: row.enabled,
        conditional: row.conditional === true,
        fiberPhase: row.fiberPhase,
        failed: row.fiberPhase === 'failed',
        waiting: row.fiberPhase === 'pending',
        broken: row.broken,
      })
      continue
    }
    if (row.entryId !== null && !existing.entryIds.includes(row.entryId)) existing.entryIds.push(row.entryId)
    if (!existing.scopes.includes(row.scope)) existing.scopes.push(row.scope)
    if (row.presetId !== undefined && !existing.presets.includes(row.presetId)) existing.presets.push(row.presetId)
    for (const dependency of row.inject ?? []) if (!existing.inject.includes(dependency)) existing.inject.push(dependency)
    existing.enabled = existing.enabled || row.enabled
    existing.conditional = existing.conditional || row.conditional === true
    existing.failed = existing.failed || row.fiberPhase === 'failed'
    existing.waiting = existing.waiting || row.fiberPhase === 'pending'
    if (existing.fiberPhase === null && row.fiberPhase !== null) existing.fiberPhase = row.fiberPhase
    if (existing.broken === undefined && row.broken !== undefined) existing.broken = row.broken
  }

  const modules = [...byModule.values()].map((module) => {
    let availability = 'available'
    let reason = ''
    if (module.broken !== undefined) {
      availability = 'broken'
      reason = module.broken
    } else if (module.failed) {
      availability = 'failed'
      reason = 'the plugin row mounted but its root fiber failed'
    } else if (!module.enabled) {
      availability = 'disabled'
      reason = 'the row is disabled in this composition'
    } else if (module.conditional) {
      availability = 'disabled'
      reason = 'the row is enabled only under a conditional expression this profile did not evaluate'
    } else if (module.waiting) {
      availability = 'waiting'
      reason = module.inject.length > 0 ? `waiting for required service(s): ${module.inject.join(', ')}` : 'the root fiber has not activated yet'
    } else if (module.fiberPhase === 'loading') {
      availability = 'loading'
    }
    return {
      ...module,
      displayName: module.moduleName.split('/').filter(Boolean).pop() ?? module.moduleName,
      availability,
      reason,
    }
  })
  modules.sort((a, b) => a.moduleName.localeCompare(b.moduleName))
  return { modules, diagnostics }
}

/** Names of the subagent providers this profile registered. */
function providerInventory(ctx) {
  const subagents = ctx.get('subagents')
  if (subagents === undefined) return { available: false, names: [] }
  let names = []
  try {
    names = subagents.list()
  } catch {
    names = []
  }
  return { available: true, names }
}

// ── whitelist resolution ────────────────────────────────────────────────────

/**
 * Resolve one agent's effective strict tool whitelist against the tools the
 * child will really see.
 *
 * `toolWhitelist` is authoritative: it is exactly what the panel (or the admin
 * tool) recorded, and it is what the child receives as `toolFilter.allow`.
 * `pluginWhitelist` is the human-facing selection that produced it; a plugin
 * that no longer resolves to any live tool is reported instead of silently
 * widening — or silently emptying — the child's tool set.
 *
 * @param liveNames - tool names the global layer registers (the only grantable names).
 * @param agent - the stored agent record.
 * @returns the resolved allow list plus one warning per dropped selection.
 */
function resolveWhitelist(liveNames, agent) {
  const warnings = []
  const allow = []
  const seen = new Set()
  for (const toolName of agent.toolWhitelist) {
    if (seen.has(toolName)) continue
    seen.add(toolName)
    if (!liveNames.has(toolName)) {
      warnings.push(
        `whitelisted tool "${toolName}" is not available in the delegating session's composition and was dropped`,
      )
      continue
    }
    allow.push(toolName)
  }
  if (agent.toolWhitelist.length === 0 && agent.pluginWhitelist.length > 0) {
    warnings.push(
      `plugin whitelist [${agent.pluginWhitelist.join(', ')}] records no tool names, so this child has no tools; pick the tools it may call in the panel (or re-save it)`,
    )
  }
  return { allow, warnings }
}

/**
 * Build the child's strict tool restriction.
 * `deny` is redundant while `allow` omits the dispatchers, but it states the
 * nesting ban in the same object that grants the child its tools.
 * @param allow - resolved whitelisted tool names.
 * @returns the restriction handed to `subagents.start`.
 */
function buildToolFilter(allow) {
  return { allow: [...allow], deny: ['preset_agent_dispatch', 'preset_agent_admin'] }
}

/** Preferred provider order: a fresh child, never a copy of the parent's history. */
const PROVIDER_PREFERENCE = ['spawn', 'subagent-spawn-in-process', 'fork']

/**
 * Pick the one-shot provider to run children on.
 * @param subagents - the subagent registry.
 * @returns the chosen provider name.
 * @throws {Error} when the profile registered no provider at all.
 */
function pickProvider(subagents) {
  const names = subagents.list()
  if (names.length === 0) {
    throw new Error('preset_agent_dispatch: this profile registers no subagent provider, so no child session can be started')
  }
  for (const preferred of PROVIDER_PREFERENCE) {
    if (names.includes(preferred)) return preferred
  }
  return names[0]
}

/** Map a run's terminal reason plus accumulated warnings onto the status vocabulary. */
function statusFor(stopReason, warnings) {
  if (stopReason === 'completed') return warnings.length === 0 ? STATUS.success : STATUS.partial
  if (stopReason === 'max-tokens' || stopReason === 'refusal') return STATUS.partial
  return STATUS.failed
}

// ── the delegation core ─────────────────────────────────────────────────────

/**
 * Run one preset agent on one self-contained task.
 * @param ctx - host context.
 * @param registry - durable registry.
 * @param args - `{ agent_id, task }` from the calling model.
 * @param exec - tool execution context (caller Agent and cancellation).
 * @returns the canonical dispatch result.
 */
async function dispatch(ctx, registry, args, exec) {
  const startedAt = Date.now()
  const agentId = text(args?.agent_id ?? args?.agentId)
  const task = text(args?.task)
  if (agentId === '') throw new Error('preset_agent_dispatch: `agent_id` is required and must be a non-empty string')
  if (task === '') throw new Error('preset_agent_dispatch: `task` is required and must be a non-empty string')

  const state = await registry.read()
  const agent = state.agents.find((candidate) => candidate.id === agentId)
  if (agent === undefined) {
    const known = state.agents.map((candidate) => candidate.id).join(', ')
    throw new Error(
      known === ''
        ? `preset_agent_dispatch: no preset agent "${agentId}" exists; none are configured yet`
        : `preset_agent_dispatch: no preset agent "${agentId}" exists; known ids: ${known}`,
    )
  }

  const parent = exec?.agent
  if (parent === undefined) throw new Error('preset_agent_dispatch: no calling agent (exec.agent was undefined)')

  const subagents = ctx.get('subagents')
  if (subagents === undefined) {
    throw new Error('preset_agent_dispatch: the `subagents` service is not mounted in this profile')
  }

  const warnings = []
  const providerName = pickProvider(subagents)
  const provider = subagents.getProvider(providerName)
  const capabilities = provider?.capabilities ?? {}
  const liveNames = grantableToolNames(parent)
  const resolved = resolveWhitelist(liveNames, agent)
  warnings.push(...resolved.warnings)

  const request = {
    label: `preset-agent:${agent.id}`,
    prompt: [{ type: 'text', text: task }],
    parent,
    signal: exec.signal,
  }
  if (capabilities.depthLimit === true) {
    request.maxDepth = 1
  } else {
    warnings.push(`provider "${providerName}" cannot enforce a delegation-depth cap, so nested delegation is not structurally blocked`)
  }
  if (capabilities.toolFilter === true) {
    request.toolFilter = buildToolFilter(resolved.allow)
  } else {
    warnings.push(`provider "${providerName}" cannot apply a tool filter, so this child runs with the parent's full tool set`)
  }
  if (agent.persona !== '') {
    if (capabilities.persona === true) request.persona = agent.persona
    else warnings.push(`provider "${providerName}" cannot apply a per-child persona; the task ran without it`)
  }
  // An empty whitelist is a legitimate configuration, not a degradation: a pure
  // reasoning or writing agent has no business calling tools, and the panel says
  // so in plain words. Only a whitelist that LOST names is a warning.

  const run = await subagents.start(providerName, request)
  const startupMs = Date.now() - startedAt

  // The strict whitelist needs a second layer here.
  //
  // `toolFilter.allow` masks what the child INHERITS, which already removes
  // every preset-row tool. It cannot remove a tool the child's OWN scope
  // registers — and the delegation tools are exactly that, which is why an
  // empty whitelist still left `subagent` visible to the child. `guard` runs
  // for every call in the scope it is registered on, so registering it through
  // `child.ctx` is what makes the whitelist strict in practice; it lives in
  // that scope and dies with the child.
  const allowSet = new Set(resolved.allow)
  pendingChildren.delete(String(run.id))
  const agents = ctx.get('agents')
  const child = agents === undefined ? undefined : agents.get(run.id)
  if (child === undefined) {
    warnings.push(
      'the child session could not be resolved while it was starting, so only the inherited-tool filter constrains what it may call',
    )
  } else {
    try {
      child.ctx.tools.guard((exec) => {
        // `run_code` is the PTC transport rather than a capability: no
        // whitelist can name it, and denying it here would break that mode.
        if (exec.name === 'run_code') return undefined
        if (allowSet.has(exec.name)) return undefined
        return `tool "${exec.name}" is outside preset agent "${agent.id}" plugin whitelist`
      })
    } catch (error) {
      warnings.push(`registering the strict whitelist guard failed: ${error?.message ?? error}`)
    }
  }

  let result
  try {
    result = await run.result
  } catch (error) {
    try {
      await run.dispose()
    } catch {
      // Disposal after an infrastructure fault is best-effort.
    }
    throw new Error(`preset_agent_dispatch: the child run failed before producing a result: ${error?.message ?? error}`)
  }
  try {
    await run.dispose()
  } catch (error) {
    warnings.push(`releasing the child session reported: ${error?.message ?? error}`)
  }

  const stopReason = text(result?.stopReason) || 'error'
  const output = contentText(result?.output)
  const status = statusFor(stopReason, warnings)
  const value = {
    status,
    agent_id: agent.id,
    agent_name: agent.name,
    provider: providerName,
    session_id: typeof run.id === 'string' ? run.id : null,
    stop_reason: stopReason,
    output,
    tool_allow: resolved.allow,
    warnings,
    startup_ms: startupMs,
    duration_ms: Date.now() - startedAt,
  }
  if (status === STATUS.failed) {
    value.error =
      text(result?.diagnostic) ||
      (stopReason === 'aborted'
        ? 'the delegation was cancelled'
        : `the child session ended with stopReason "${stopReason}" and produced no usable output`)
  }
  return value
}

/** Human-readable projection of one dispatch value. */
function renderDispatch(value) {
  const lines = [
    `[${value.status}] preset agent "${value.agent_id}" (${value.agent_name}) — provider ${value.provider}, stopReason ${value.stop_reason}, ${value.duration_ms}ms`,
  ]
  if (value.output !== '') lines.push('', value.output)
  if (value.error !== undefined && value.error !== '') lines.push('', `error: ${value.error}`)
  if (Array.isArray(value.warnings) && value.warnings.length > 0) {
    lines.push('', 'warnings:')
    for (const warning of value.warnings) lines.push(`- ${warning}`)
  }
  return [{ type: 'text', text: lines.join('\n') }]
}

// ── model-facing tools ──────────────────────────────────────────────────────

/** The `preset_agent_dispatch` tool. */
function dispatchTool(ctx, registry) {
  return defineTool({
    name: 'preset_agent_dispatch',
    description:
      'Delegate one self-contained task to a configured preset agent and return its result. Each preset agent has its own persona and its own strict plugin whitelist: the child session sees only the tools that whitelist grants, cannot delegate further, and runs in an isolated child session that ends when the task finishes. Call this autonomously whenever a user request matches a preset agent description — do not wait to be asked, and do not ask the user which agent to use. Treat an explicit `$<agent_id> <task>` prefix in the user message as a direct instruction to dispatch that text to that agent immediately, without a clarifying question. Call preset_agent_admin with action "list" whenever you need the current ids or their trigger domains, and never claim a delegation happened without calling this tool.',
    parameters: {
      agent_id: {
        type: 'string',
        required: true,
        description: 'Id of the preset agent to run, exactly as listed by preset_agent_admin action "list".',
      },
      task: {
        type: 'string',
        required: true,
        description:
          'A complete, self-contained task statement. The child sees only this text plus its own persona, so include every input, path, and acceptance condition it needs.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', enum: [STATUS.success, STATUS.partial, STATUS.failed] },
          agent_id: { type: 'string' },
          agent_name: { type: 'string' },
          provider: { type: 'string' },
          session_id: { type: 'string' },
          stop_reason: { type: 'string' },
          output: { type: 'string' },
          tool_allow: { type: 'array', items: { type: 'string' } },
          warnings: { type: 'array', items: { type: 'string' } },
          error: { type: 'string' },
          startup_ms: { type: 'integer' },
          duration_ms: { type: 'integer' },
        },
      },
      render(_args, value) {
        return renderDispatch(value)
      },
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      return dispatch(ctx, registry, args, exec)
    },
  })
}

/** The `preset_agent_admin` tool: registry CRUD for the calling model. */
function adminTool(ctx, registry) {
  return defineTool({
    name: 'preset_agent_admin',
    description:
      'Inspect and edit the preset-agent registry (the same data the sidebar panel edits). Actions: "list" (every preset agent with its name, trigger description and whitelists), "get" (one agent), "create" (add a new agent), "update" (change fields of an existing agent), "delete" (remove one). Prefer the panel when a human is present; use this tool when the user asks you to configure preset agents directly.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['list', 'get', 'create', 'update', 'delete'],
        description: 'Registry operation to perform.',
      },
      id: { type: 'string', description: 'Agent id (get/update/delete/create).' },
      name: { type: 'string', description: 'Display name (create/update).' },
      description: { type: 'string', description: 'Trigger-domain description the main agent matches tasks against (create/update).' },
      persona: { type: 'string', description: 'System persona for the child session (create/update).' },
      plugin_whitelist: {
        type: 'array',
        items: { type: 'string' },
        description: 'Exact plugin module specifiers this agent may use (create/update).',
      },
      tool_whitelist: {
        type: 'array',
        items: { type: 'string' },
        description: 'Exact tool names the child may call; this is what the strict filter enforces (create/update).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          action: { type: 'string' },
          message: { type: 'string' },
          agents: { type: 'array', items: { type: 'json' } },
        },
      },
      render(_args, value) {
        const lines = [`[${value.ok ? 'ok' : 'failed'}] preset_agent_admin ${value.action}: ${value.message}`]
        for (const agent of value.agents ?? []) {
          const plugins =
            Array.isArray(agent.pluginWhitelist) && agent.pluginWhitelist.length > 0 ? agent.pluginWhitelist.join(', ') : '(none)'
          const tools =
            Array.isArray(agent.toolWhitelist) && agent.toolWhitelist.length > 0 ? agent.toolWhitelist.join(', ') : '(none)'
          lines.push(
            `- ${agent.id} — ${agent.name}`,
            `  description: ${agent.description || '(none)'}`,
            `  plugins: ${plugins}`,
            `  tools: ${tools}`,
          )
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const action = text(args?.action)
      try {
        switch (action) {
          case 'list': {
            const state = await registry.read()
            return {
              ok: true,
              action,
              message: `${state.agents.length} preset agent(s) configured`,
              agents: state.agents,
            }
          }
          case 'get': {
            const id = text(args?.id)
            const state = await registry.read()
            const agent = state.agents.find((candidate) => candidate.id === id)
            if (agent === undefined) return { ok: false, action, message: `no preset agent "${id}"`, agents: [] }
            return { ok: true, action, message: `preset agent "${id}"`, agents: [agent] }
          }
          case 'create':
          case 'update': {
            const id = text(args?.id)
            if (id === '') return { ok: false, action, message: '`id` is required', agents: [] }
            const outcome = await registry.transaction((state) => {
              const index = state.agents.findIndex((candidate) => candidate.id === id)
              if (action === 'create' && index >= 0) throw new Error(`preset agent "${id}" already exists`)
              if (action === 'update' && index < 0) throw new Error(`no preset agent "${id}"`)
              const base = index >= 0 ? state.agents[index] : { id }
              const merged = { ...base }
              for (const key of ['name', 'description', 'persona']) {
                if (typeof args?.[key] === 'string') merged[key] = args[key]
              }
              if (Array.isArray(args?.plugin_whitelist)) merged.pluginWhitelist = args.plugin_whitelist
              if (Array.isArray(args?.tool_whitelist)) merged.toolWhitelist = args.tool_whitelist
              const record = normalizeAgent(merged, base)
              if (index >= 0) state.agents[index] = record
              else state.agents.push(record)
              return { value: record }
            })
            return { ok: true, action, message: `saved preset agent "${outcome.id}"`, agents: [outcome] }
          }
          case 'delete': {
            const id = text(args?.id)
            const outcome = await registry.transaction((state) => {
              const index = state.agents.findIndex((candidate) => candidate.id === id)
              if (index < 0) throw new Error(`no preset agent "${id}"`)
              state.agents.splice(index, 1)
              return { value: id }
            })
            return { ok: true, action, message: `deleted preset agent "${outcome}"`, agents: [] }
          }
          default:
            return { ok: false, action, message: `unknown action "${action}"`, agents: [] }
        }
      } catch (error) {
        return { ok: false, action, message: error?.message ?? String(error), agents: [] }
      }
    },
  })
}

// ── browser API ─────────────────────────────────────────────────────────────

/** Read a JSON request body. */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('request body is too large')
    chunks.push(chunk)
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  if (raw === '') return {}
  return JSON.parse(raw)
}

/** Write one JSON response. */
function sendJson(res, status, value) {
  const body = `${JSON.stringify(value)}\n`
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/** The full panel payload: registry, live inventory, and dispatch wiring. */
async function snapshot(ctx, registry) {
  const state = await registry.read()
  const plugins = await pluginInventory(ctx)
  const tools = await toolInventory(ctx)
  const providers = providerInventory(ctx)
  return {
    state,
    statePath: stateFilePath(),
    plugins: plugins.modules,
    diagnostics: [...plugins.diagnostics, ...tools.diagnostics],
    tools: tools.rows,
    providers,
  }
}

/** Route one browser request. */
async function handleApi(ctx, registry, req, res) {
  const url = new URL(req.url ?? API_PREFIX, 'http://127.0.0.1')
  const route = url.pathname.slice(API_PREFIX.length) || '/'
  const method = (req.method ?? 'GET').toUpperCase()

  if (method === 'GET' && (route === '/' || route === '/state')) {
    sendJson(res, 200, await snapshot(ctx, registry))
    return
  }
  if (method === 'GET' && route === '/plugins') {
    const plugins = await pluginInventory(ctx)
    sendJson(res, 200, { plugins: plugins.modules, diagnostics: plugins.diagnostics })
    return
  }
  if (method === 'POST' && route === '/agents') {
    const body = await readJsonBody(req)
    const outcome = await registry.transaction((state) => {
      const candidate = normalizeAgent(body, state.agents.find((agent) => agent.id === text(body?.id)))
      const index = state.agents.findIndex((agent) => agent.id === candidate.id)
      if (index >= 0) state.agents[index] = candidate
      else state.agents.push(candidate)
      return { value: candidate }
    })
    sendJson(res, 200, { ok: true, agent: outcome, ...(await snapshot(ctx, registry)) })
    return
  }
  if (method === 'POST' && route === '/agents/delete') {
    const body = await readJsonBody(req)
    const id = text(body?.id)
    const running = liveChildren(ctx)
    await registry.transaction((state) => {
      const index = state.agents.findIndex((agent) => agent.id === id)
      if (index < 0) throw new Error(`no preset agent "${id}"`)
      state.agents.splice(index, 1)
      return { value: id }
    })
    sendJson(res, 200, { ok: true, id, runningChildren: running, ...(await snapshot(ctx, registry)) })
    return
  }
  sendJson(res, 404, { ok: false, error: `unknown route ${method} ${route}` })
}

/**
 * Live delegated children, for the delete confirmation. Read-only and
 * best-effort: an unmounted session store reports none.
 * @param ctx - host context.
 * @returns one row per live session whose origin is `subagent`.
 */
function liveChildren(ctx) {
  const agents = ctx.get('agents')
  if (agents === undefined) return []
  try {
    return agents
      .list()
      .filter((agent) => agent?.session?.header?.origin === 'subagent')
      .map((agent) => ({
        sessionId: agent.session?.id ?? null,
        parentSession: agent.session?.header?.parentSession ?? null,
      }))
  } catch {
    return []
  }
}

// ── plugin body ─────────────────────────────────────────────────────────────

/**
 * Register the registry, both model-facing tools, and the browser API route.
 * @param ctx - the plugin's Cordis context.
 */
export function apply(ctx) {
  trace('apply start')
  const registry = new Registry(ctx)
  ctx.tools.register(dispatchTool(ctx, registry))
  ctx.tools.register(adminTool(ctx, registry))
  trace('tools registered')

  // Remember every published child so a dispatch can claim its own. The event
  // carries the child's session id while `subagents.start()` is still running,
  // which is the only moment this plugin can learn it before the child's first
  // turn begins.
  ctx.on('subagent/start', (info) => {
    if (info !== undefined && info !== null && info.id !== undefined) pendingChildren.add(String(info.id))
  })

  // The web server is an optional collaborator, and it is frequently not
  // available yet when this row activates: `ctx.get()` reads only what the
  // context already provides, and a later row's service may still be pending.
  // `ctx.inject` defers the route to the moment the carrier appears, so the
  // model-facing tools never wait on the panel API — and a headless profile
  // that never composes a web server still gets the tools.
  ctx.inject(['webServer'], (webCtx) => {
    const webServer = webCtx.get('webServer')
    if (webServer === undefined) {
      trace('webServer injection fired without the service; panel route not mounted')
      return
    }
    const handler = (req, res) => {
      handleApi(webCtx, registry, req, res).catch((error) => {
        try {
          sendJson(res, 500, { ok: false, error: error?.message ?? String(error) })
        } catch {
          // The response may already be committed; nothing left to report on.
        }
      })
    }
    const claim = () => webServer.register({ kind: 'prefix', path: API_PREFIX, handler })
    try {
      // `effect()` ties the route to this fiber: unloading, updating, or
      // removing this plugin row removes the route, so the next generation can
      // claim the same path. A bare `register()` leaks it and makes every later
      // mount fail on the duplicate path.
      if (typeof webCtx.effect === 'function') {
        webCtx.effect(claim, 'preset-agent-manager:api')
        trace('route claimed through effect')
      } else {
        claim()
        trace('route claimed directly (effect unavailable)')
      }
    } catch (error) {
      trace(`route claim failed: ${error?.message ?? error}`)
      ctx.logger?.warn?.(
        `preset-agent-manager: could not claim ${API_PREFIX} (${error?.message ?? error}); the model-facing tools stay active, and the panel route is served by whichever generation already owns that path`,
      )
    }
  })
  trace('apply done')
  ctx.logger?.info?.('preset-agent-manager: registered preset_agent_dispatch and preset_agent_admin')
}

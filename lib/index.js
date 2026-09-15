/**
 * dsh-preset-agent-manager — Host half entry.
 *
 * A deliberately thin shell: the implementation lives in `./impl.js` and is
 * loaded through a revision-keyed URL. Two consequences, both intended:
 *
 *  - Rolling the implementation forward is a hot operation. A custom profile
 *    declares `patchReload: live`, so editing this row's `config.rev` makes the
 *    Loader re-apply the row, and the new revision string makes Node evaluate
 *    `impl.js` again instead of serving it from the ESM cache.
 *  - A shipped, frozen revision behaves like an ordinary static import: the
 *    same `rev` always resolves to the same module instance.
 *
 * The shell also writes a one-line boot trace beside the registry, because a
 * Loader row that fails to activate reports only a failed fiber — the trace is
 * what makes "the shell never ran" distinguishable from "the implementation
 * threw".
 *
 * @module dsh-preset-agent-manager
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

/** Cordis plugin name; also the Loader row id in this package's cordis.patch.yml. */
export const name = 'preset-agent-manager'

/**
 * `tools` is the one hard dependency: this plugin exists to contribute two
 * model-facing tools. Every other service (`subagents`, `webServer`,
 * `agentPresets`, `loader`, `agents`) is read optionally, so a profile that
 * mounts only part of the stack still activates this row.
 */
export const inject = ['tools']

/** Append one line to this plugin's boot trace, never throwing. */
function trace(line) {
  try {
    const home = (process.env.DSH_HOME ?? '').trim() || path.join(homedir(), '.dsh')
    const directory = path.join(home, 'data', 'dsh-preset-agent-manager')
    mkdirSync(directory, { recursive: true })
    appendFileSync(path.join(directory, 'boot.log'), `${new Date().toISOString()} ${line}\n`)
  } catch {
    // Diagnostics must never be the reason a plugin fails to load.
  }
}

/**
 * Load the implementation revision this row configured and run it.
 * @param ctx - the plugin's Cordis context.
 * @param config - the Loader row's config; `rev` selects the implementation revision.
 */
export async function apply(ctx, config) {
  const rev = config?.rev === undefined ? '1' : String(config.rev)
  trace(`shell: apply start (rev=${rev})`)
  try {
    const implementation = await import(`./impl.js?rev=${encodeURIComponent(rev)}`)
    trace(`shell: impl.js?rev=${rev} imported (exports: ${Object.keys(implementation).join(',')})`)
    const result = implementation.apply(ctx, config)
    trace('shell: impl.apply returned')
    return result
  } catch (error) {
    trace(`shell: FAILED ${error?.stack ?? error?.message ?? error}`)
    throw error
  }
}

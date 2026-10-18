# dsh-preset-agent-manager

DSH（DeepSeek Harness）插件：**预设智能体管理器**。

它把「预设智能体」做成 DSH 里的一等公民：每个预设智能体有自己的 id、名称、触发域描述、persona，以及一份**严格插件/工具白名单**。主智能体可以在对话中自主调用 `preset_agent_dispatch` 把任务派给它，子会话在独立会话中运行、只拿到白名单内的工具、无法再次委派、结束后销毁。

---

## 功能

| 能力 | 实现 |
|---|---|
| 侧边栏底部入口 + 全屏管理面板 | 浏览器半注册在 `sidebar.footer.action` 与 `shell.overlay` |
| 创建 / 编辑 / 删除预设智能体 | 面板；删除需二次确认并显示当前活跃子会话数 |
| 插件白名单 | 从当前 profile 的 Loader 行与各 preset 组合行中勾选，逐行显示启用状态、fiber 阶段、不可用原因 |
| 工具白名单（严格生效） | 勾选后写入 `toolWhitelist`，运行时在子会话作用域内先 `tools.restrict()` 掩码、再 `tools.guard()` 兜底 |
| 模型工具 | `preset_agent_dispatch(agent_id, task)`、`preset_agent_admin(action, …)` |
| 持久化 | `$DSH_HOME/data/dsh-preset-agent-manager/agents.json`（原子写入 + 损坏文件自动旁置） |

## 兼容性

| 项目 | 说明 |
|---|---|
| 目标运行时 | **DSH `0.2.1-rc.2`**（桌面运行时；`@deepseek-ai/dsh-tools` 0.2.1-rc.2） |
| Host 实现版本 | `config.rev: '23'` |
| 旧版运行时 | 0.1.x 不再受支持：0.2.x 移除了 `subagents.start()`、`request.toolFilter`、`request.persona` 与 `agentPresets.standingKeyFor()` |

适配点（实现细节见 `lib/impl.js` 注释）：委派改用 `subagents.startActivation({ provider, label, request, signal, delivery: 'caller' })`；策略安装挂在 `subagent/start` 发布通知上，并在激活返回后按 `childId` 校验、回滚并发错配；工具清单改用 `agentPresets.acquireScope()`；persona 通过在子作用域注册 `deployment:persona-prefix/suffix` 段落实现。

## 目录结构

```
dsh-preset-agent-manager/
  package.json         # type: module；dsh.bundle.patch + dsh.client（浏览器行）
  cordis.patch.yml     # 本包作为 bundle 时的插入行（含 config.rev）
  lib/index.js         # host 入口：薄壳，按 config.rev 加载 impl.js
  lib/impl.js          # host 实现：注册表、两个模型工具、HTTP API
  lib/client.js        # 浏览器半：手写 bundle（window.__ModuleLoader__）
```

## 安装与激活

### 方式 A：标准 `dsh plugin`（需要 pnpm）

本包声明了 `dsh.bundle.patch`，所以 `dsh plugin` 会在安装成功后**自动把本包加入 profile 的 `dsh.profile.bundles`**：

```powershell
dsh plugin --profile web add file:$env:USERPROFILE\.dsh\plugins\dsh-preset-agent-manager
```

> `dsh plugin` 是一个 pnpm 薄转发器。若提示 `pnpm not found on PATH`，先 `corepack enable pnpm` 或 `npm i -g pnpm`。
> `dsh.profile.bundles` 只在 profile 启动时读取，**这条路径需要重启 profile**。

### 方式 B：不依赖 pnpm 的手工安装

```powershell
# 1. 放入 profile 的解析路径（Node 从 profile 目录向上查找 node_modules）
$dst = "$env:DSH_HOME\profiles\web\node_modules\dsh-preset-agent-manager"
New-Item -ItemType Directory -Force $dst | Out-Null
Copy-Item "$env:USERPROFILE\.dsh\plugins\dsh-preset-agent-manager\*" $dst -Recurse -Force

# 2. 激活：把下面 4 行追加到 profile 的 patch 层
#    （该 profile 声明了 patchReload: live，正常情况无需重启）
```

```yaml
- insert:
    - id: preset-agent-manager
      name: 'dsh-preset-agent-manager'
      config:
        rev: '23'
```

### 卸载 / 停用

- 停用（保留数据与文件）：删除 profile `cordis.patch.yml` 里的 insert 块。
- 卸载：移除 `profiles/web/node_modules/dsh-preset-agent-manager` 与上述 insert 块；数据文件按需保留。

## 使用

1. 侧边栏底部点击 **⚉ 预设智能体** 打开面板。面板按视口自适应（`min(1440px, 100vw-40px)` × `min(940px, 100vh-40px)`），窗口缩放时跟随；新建/编辑表单直接接管面板主体并按宽度自动分两栏或堆叠，不再是嵌套的小弹窗。
2. **新建预设智能体**：填 id / 名称 / 描述（触发域）/ persona；勾选插件白名单；勾选该智能体真正可以调用的工具。名称与描述就是主智能体判断「该不该派给它」的全部依据。
3. 保存后主智能体即可在对话中自主委派，或由你用显式指令触发：
   ```
   用日志追踪器排查 D:\logs\app.log 里的超时错误
   ```
4. 主智能体侧调用形态：

```json
{ "agent_id": "log-tracer", "task": "自包含的任务描述" }
```

返回：`status`（`success` / `partial` / `failed`）、`output`、`tool_allow`、`warnings`、`error`、`startup_ms`、`duration_ms`、`session_id`。

## 机制与保证

- **委派走 DSH 自己的 subagent seam**：`ctx.subagents.startActivation({ provider, label, request, signal, delivery: 'caller' })`，provider 取 `spawn`（当前 profile 同时注册 `spawn` 与 `fork`）。`delivery: 'caller'` 让结果回到本工具，而不向父会话注入完成通知（否则输出会出现两次）。子会话是普通子 Agent，拥有自己的 session 与 scope。
- **禁止嵌套**：`maxDepth: 1`（父 depth 0，子 depth 1，再委派即被深度上限拒绝；子会话的运行上下文会直接写明「剩余层级 0」）。白名单 mask 与 guard 是第二、三重保证——见下。
- **严格白名单语义**（两层，均经实测确认）：
  1. **继承层掩码** — 在子会话作用域内调用 `tools.restrict({ allow, deny })`，它过滤子会话**继承**的一切（全局层 + 全部祖先层，包含所有 agent preset 行注册的工具）。被勾选的工具可用，未勾选的在子会话 prompt 中不存在。
  2. **自身层 guard** — 第 1 层按设计豁免子会话**自身作用域**注册的工具（如运行时为子代理注入的 `ops_bash`、以及委派工具 `subagent`）。主机半在 `subagent/start` 发布通知里再注册一道单调 guard：不在白名单内的调用一律返回
     `tool "<name>" is outside preset agent "<id>" plugin whitelist`。实测子会话原文回执该错误。`run_code`（PTC 传输而非能力）被显式放行。
  - 白名单名字必须能在调用方组合中解析：主机半用父 agent 的作用域键（`scopeOf(parent.ctx)`，回退到 `composedPreset` + `acquireScope`）取真实工具视图，解析不了的名字在委派前剔除并写入 `warnings`，不会让委派抛错。
  - 两层都在子会话自己的作用域内，随子会话销毁。策略安装时机是 `subagent/start`（子会话发布、首次 prompt 组装之前）；并发委派会串行化发布窗口，并按 `childId` 校验、回滚错配策略。
- **空白名单是合法配置**：不勾任何工具的预设智能体（纯推理/写作型）正常运行且返回 `success`；只有白名单**丢失了名字**才会降级为 `partial` 并附警告。
- **隔离与降级**：每个预设智能体在自己的子会话中组装环境，会话结束即销毁。白名单里出现不可解析的名字会降级为 `partial` 并附警告，不会中断主会话。
- **persona**：在子会话作用域注册 `deployment:persona-prefix` / `deployment:persona-suffix` 段落，遮蔽该子会话的部署 persona，只覆盖该子会话，不影响父会话与兄弟会话。
- **并发**：`preset_agent_dispatch` 声明 `isConcurrencySafe: () => true`，同一预设智能体的多次委派各自独立运行；仅 `startActivation` 的发布窗口被串行化（毫秒级），子任务执行完全并发。
- **持久化**：`agents.json` 采用「临时文件 + rename」原子写入，写入串行化；损坏的 JSON 会被旁置为 `agents.json.corrupt-<ts>` 而不是被覆盖。

## 数据文件

```json
{
  "version": 1,
  "agents": [
    {
      "id": "log-tracer",
      "name": "日志追踪器",
      "description": "排查日志、慢查询、错误堆栈",
      "persona": "你是一个专业的日志分析专家……",
      "pluginWhitelist": ["@deepseek-ai/dsh-tool-fs"],
      "toolWhitelist": ["read", "grep"],
      "createdAt": "2026-09-15T10:00:00.000Z",
      "updatedAt": "2026-09-15T10:00:00.000Z"
    }
  ]
}
```

`toolWhitelist` 是本插件对参考结构的扩展字段：它是真正生效的严格白名单，`pluginWhitelist` 记录人在面板上的选择意图并驱动不可用插件的告警。

## HTTP 接口（浏览器半使用）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/preset-agents-api/state` | 注册表 + Loader/preset 插件清单 + 工具清单 + provider + 诊断 |
| GET | `/preset-agents-api/plugins` | 仅插件清单 |
| POST | `/preset-agents-api/agents` | 新建或更新一个预设智能体 |
| POST | `/preset-agents-api/agents/delete` | 删除（返回 `runningChildren`） |

路由由 `ctx.effect()` 绑定到插件 fiber，卸载或更新插件行时随 fiber 一并移除。

## 热更新（`config.rev`）

`lib/index.js` 是按 `config.rev` 加载 `lib/impl.js` 的薄壳：改动 `impl.js` 后把 patch 里的 `rev` 递增，Loader 重新应用该行并让 Node 重新求值模块，无需重启 profile。同一个 `rev` 始终解析到同一个模块实例，行为与静态导入一致。

> 注意：若某次热更新导致插件 fiber 装载失败，profile 的 patch 监视器可能停止响应后续改动；此时重启 profile 即可恢复。

## 已知限制

- **没有 pnpm 就无法使用 `dsh plugin add` 的裸包名形式**（取决于环境是否安装 pnpm）。`file:` 路径形式同样需要 pnpm；方式 B 完全绕开。
- **预设智能体不是 agent preset**：它复用父会话的 preset 组合，靠子会话作用域内的 `tools.restrict()` + `tools.guard()` + `maxDepth` 做约束。因此不能授予某个 agent preset 行独有的工具——只能从父会话本来就继承的工具集合里挑。
- **子会话自身作用域注册的工具无法从 prompt 中隐藏**（`tools.restrict()` 按设计只掩码继承层）：典型如运行时注入的 `ops_bash`、以及委派工具 `subagent`。它们会出现在子会话的工具清单里；若被显式加入白名单（例如通过 `preset_agent_admin`），guard 会放行该调用，未加入的调用一律被拒绝并返回原文错误。
- **面板的插件清单来自 Loader 与 preset 组合**，`fiberPhase: 'failed'` 只有状态位，没有错误堆栈摘要（DSH 当前未提供 entry 级错误读取接口）。

## License

MIT — 见 [LICENSE](./LICENSE)。

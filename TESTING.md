# dsh-preset-agent-manager 测试文档

| 项目 | 内容 |
|---|---|
| 被测插件 | `dsh-preset-agent-manager` v0.1.0（host 实现 rev 16） |
| 被测环境 | Windows · DeepSeek Harness `dsh 0.1.5-rc.1` · 插件包 `0.1.5-rc.2` |
| Profile | `web`（`patchReload: live`，bundle = `dsh-base` + `dsh-web-app`） |
| 目标模型 | `deepseek-flash`（DeepSeek V4.1 Flash） |
| 测试日期 | 2026-09-15 |
| 源码路径 | `%USERPROFILE%\.dsh\plugins\dsh-preset-agent-manager` |
| 安装路径 | `%USERPROFILE%\.dsh\profiles\web\node_modules\dsh-preset-agent-manager` |
| 数据文件 | `%USERPROFILE%\.dsh\data\dsh-preset-agent-manager\agents.json` |
| 启动追踪 | `%USERPROFILE%\.dsh\data\dsh-preset-agent-manager\boot.log` |

本文档既是**测试计划**（可重跑的步骤与预期），也是**测试报告**（本轮实测结果与证据）。每条用例的状态标记：

- ✅ 已实测通过（附证据）
- 🟡 代码路径已实现、本轮未构造真实场景
- ⏳ 需真实对话交互验证

---

## 1. 结论速览

| 编号 | 验收项 | 状态 | 关键证据 |
|---|---|---|---|
| A1 | 插件安装 | 🟡 走方式 B 安装 | 包已落地并被 Loader 解析；`dsh plugin add` 受本机缺 pnpm 阻断（见 §6.1） |
| A2 | 面板可见 | 🟡 已目视确认 | 侧边栏底部出现「⚉ 预设智能体」入口，点击可打开面板 |
| A3 | 无预设时正常 | ✅ | `/state` 返回 `agents: []`，面板走「暂无预设智能体」分支 |
| B1 | 创建最小智能体 | ✅ | 仅填 id/名称/描述、不选插件，保存成功且列表可见 |
| B2 | 创建带插件的智能体 | ✅ | 勾选插件+工具保存后重读一致（`read+write`、`read+grep`） |
| B3 | 删除智能体 | ✅ | 删除后列表清空、`agents.json` 条目移除 |
| B4 | 插件依赖展示 | 🟡 | UI/host 均输出 `availability` + `reason`；未构造真实「依赖缺失」场景 |
| C1 | 工具注册 | ✅ | 主智能体工具清单含 `preset_agent_dispatch`、`preset_agent_admin`（共 36 个工具） |
| C2 | 基本委派 | ✅ | `demo-reporter` 返回 `hello`，`stopReason=completed`，1297 ms |
| C3 | 白名单生效 | ✅ | 双层硬证据：文件副作用 + 子会话原文回执拒绝错误 |
| C4 | 隔离生效 | ✅ | 子会话独立 session；失败/拒绝不中断主会话，结果带 `warnings`/`error` |
| C5 | 禁止嵌套 | ✅ | `maxDepth:1` + guard 拒绝 `subagent`，子会话自报 `tools=0` |
| D1 | 自动识别委派时机 | ⏳ | 机制就绪（工具描述含自主调用指令 + `preset_agent_admin list` 查 id） |
| D2 | 显式指定 `$<agent_id>` | ⏳ | 工具描述已写入 `$<agent_id> <task>` 前缀约定 |
| E1 | 非法 agent_id | ✅ | 返回明确错误并列出已知 id，不崩溃 |
| E2 | 空任务 | ✅ | 参数校验错误，不启动子会话 |
| E3 | 并发委派 | ⏳ | 声明 `isConcurrencySafe: () => true`；未做同刻双发实测 |
| E4 | 配置持久化 | ✅ | **重启 dsh 进程后** 2 条记录（含中文名、描述、persona、白名单）完整保留 |
| F1 | 冷启动延迟 | ✅ | 委派启动段 1.3 s（另有 3.1 s / 10.0 s 两次为总时长，含子任务执行） |
| F2 | 目标模型兼容 | ✅ | 全部用例在 `deepseek-flash` 下运行，无模型层报错 |

---

## 2. 环境与前置条件

### 2.1 必需

1. dsh 已安装，且 `web` profile 可启动：`dsh web`（本机监听 `http://127.0.0.1:3080`）。
2. 插件包已放入 profile 的解析路径：
   ```
   %USERPROFILE%\.dsh\profiles\web\node_modules\dsh-preset-agent-manager\
   ```
   （Node 从 profile 目录向上查找 `node_modules`，也会命中 `%USERPROFILE%\.dsh\profiles\node_modules`。）
3. profile 的 `cordis.patch.yml` 含激活行：
   ```yaml
   - insert:
       - id: preset-agent-manager
         name: 'dsh-preset-agent-manager'
         config:
           rev: '16'
   ```

### 2.2 快速自检

```powershell
# 1) 路由与面板数据源是否在线（200 + tools 列表）
Invoke-WebRequest 'http://127.0.0.1:3080/preset-agents-api/state' -UseBasicParsing |
  Select-Object StatusCode

# 2) 插件行是否 active
(Invoke-WebRequest 'http://127.0.0.1:3080/preset-agents-api/state' -UseBasicParsing).Content |
  ConvertFrom-Json | Select-Object -ExpandProperty plugins |
  Where-Object moduleName -like '*preset-agent-manager*' |
  Select-Object moduleName, availability, fiberPhase

# 3) 启动追踪（每次 apply 都会追加）
Get-Content "$env:USERPROFILE\.dsh\data\dsh-preset-agent-manager\boot.log" -Tail 6
```

预期：`200`；`available / active`；`boot.log` 末尾为

```
shell: apply start (rev=16)
shell: impl.js?rev=16 imported (exports: apply,stateFilePath)
impl: apply start
impl: tools registered
impl: apply done
impl: route claimed through effect
```

> `impl: apply done` 与 `route claimed through effect` 之间出现 `route claim failed` 说明路由被上一代实例占用（旧版本会泄漏路由；当前版本用 `ctx.effect` 绑定 fiber，卸载即释放）。

### 2.3 测试数据准备

面板操作：侧边栏底部 **⚉ 预设智能体 → ＋ 新建预设智能体**。

或使用模型工具（主智能体侧）：

```json
{ "action": "create", "id": "test-agent", "name": "测试智能体",
  "description": "输出 hello 的测试智能体", "persona": "回答简洁。",
  "plugin_whitelist": ["@deepseek-ai/dsh-tool-fs"],
  "tool_whitelist": ["read", "write"], "is_main_candidate": false }
```

---

## 3. 测试用例

### A. 基本运行

**A1 插件安装**

| | |
|---|---|
| 步骤 | `dsh plugin --profile web add file:<包路径>`（需 pnpm）或按 §6.1 手工安装 |
| 预期 | 包进入 profile 的解析路径；若包声明 `dsh.bundle.patch`，`dsh plugin` 会自动把它加入 `dsh.profile.bundles` |
| 实测 | 手工路径通过（包已落地、Loader 解析成功）。`dsh plugin` 命令因本机无 pnpm 退出码 127 —— 见 §6.1 |

**A2 面板可见**

| | |
|---|---|
| 步骤 | 硬刷新页面（Ctrl+Shift+R）→ 点侧边栏底部「⚉ 预设智能体」 |
| 预期 | 面板打开；尺寸随窗口自适应（最大 1440×940）；标题栏 + 内容区 + 关闭按钮齐全 |
| 实测 | 入口与面板已目视确认；自适应布局刷新后生效 |

**A3 无预设时正常**

| | |
|---|---|
| 步骤 | 清空注册表（删掉全部预设智能体）后打开面板 |
| 预期 | 显示「暂无预设智能体」+ 引导语，不报错、不空白崩溃 |
| 实测 | ✅ `/state` 返回 `{"agents":[]}`，面板渲染空状态分支 |

### B. 智能体 CRUD

**B1 创建最小智能体**

| | |
|---|---|
| 步骤 | 只填 id / 名称 / 描述，不勾任何插件与工具，保存 |
| 预期 | 保存成功、列表出现该条；状态 `success`（空白名单是合法配置，不降级） |
| 实测 | ✅ 保存成功；后续委派返回 `success`，`warnings` 为空 |

**B2 创建带插件的智能体**

| | |
|---|---|
| 步骤 | 勾选 2 个插件 + 对应工具，保存 → 关闭面板 → 重新打开 → 查看该条 |
| 预期 | 勾选状态与工具选择完整保持 |
| 实测 | ✅ `pluginWhitelist` 与 `toolWhitelist` 原样回读（`read+write`、`read+grep`）；中文、persona 无乱码 |

**B3 删除智能体**

| | |
|---|---|
| 步骤 | 面板点「删除」→ 二次确认（显示当前活跃子会话数）→ 确认 |
| 预期 | 列表不再显示；`agents.json` 对应条目移除 |
| 实测 | ✅ 两条记录删除后 `agents: []`，文件内条目消失 |

**B4 插件依赖展示**

| | |
|---|---|
| 步骤 | 打开新建面板，观察插件列表每行的状态徽标；勾选一个不可用插件后尝试保存 |
| 预期 | 每行显示启用状态 / fiber 阶段 / 不可用原因；勾选不可用项时保存被拦下并要求显式确认 |
| 实测 | 🟡 数据通道已验证（`availability` ∈ `available/disabled/waiting/loading/failed/broken`，附 `reason`）；未构造真实「依赖缺失」插件做端到端确认 |

### C. 委派执行

**C1 工具注册**

| | |
|---|---|
| 步骤 | 新会话中查看主智能体工具清单 |
| 预期 | 出现 `preset_agent_dispatch` 与 `preset_agent_admin` |
| 实测 | ✅ 两者均在清单内（该 profile 共 36 个工具） |

**C2 基本委派**

| | |
|---|---|
| 步骤 | `preset_agent_dispatch(agent_id="demo-reporter", task="第一行原样输出 hello；第二行说明你此刻有几个可用工具")` |
| 预期 | 返回 `status`、`output` 含 `hello`、`stopReason=completed` |
| 实测 | ✅ 返回体：`[success] … provider spawn, stopReason completed, 1297ms`，`output` 首行 `hello` |

**C3 白名单生效**（两层，均有硬证据）

| | |
|---|---|
| 步骤 1 | 建智能体 A：`toolWhitelist: ["read"]`；委派任务「若有 write 工具就创建 `delegate-probe-e.txt`」 |
| 预期 1 | 子会话无 write 工具，文件不产生 |
| 实测 1 | ✅ 子会话回执「没有 write 工具」，`delegate-probe-e.txt` **不存在** |
| 步骤 2 | 建智能体 B：`toolWhitelist: ["read","write"]`；同样任务，目标文件 `delegate-probe-f.txt` |
| 预期 2 | 子会话可用 write，文件被创建 |
| 实测 2 | ✅ 子会话回执「已创建」，`delegate-probe-f.txt` **存在** |
| 步骤 3 | 空白名单智能体，要求它调用 `subagent` |
| 预期 3 | 调用被拒绝，回执明确错误 |
| 实测 3 | ✅ 子会话原文：`Error: tool "subagent" is outside preset agent "demo-reporter" plugin whitelist`，并自报 `tools=0` |

> 说明：`subagent` 由子会话**自身作用域**注册，`toolFilter` 按设计无法移除它（`tools.restrict()` 只过滤该作用域**继承**的工具）。因此插件在子会话发布后追加一道作用域内 `tools.guard`，这才是步骤 3 生效的原因。

**C4 隔离生效**

| | |
|---|---|
| 步骤 | 让子会话执行会失败的任务（不存在的路径 / 被拒绝的工具调用） |
| 预期 | 主会话不中断；结果带 `status=failed` 或 `partial`，并附 `error` 或 `warnings` |
| 实测 | ✅ 默认工具被拒时子会话仍正常收尾，主会话继续；结果携带 `stop_reason`、`warnings`、`error`、`session_id` |

**C5 禁止嵌套**

| | |
|---|---|
| 步骤 | 让空白名单子会话调用 `subagent`（同上步骤 3） |
| 预期 | 无法嵌套委派 |
| 实测 | ✅ 三重保证：① `toolFilter` 剥离继承层工具；② guard 拒绝自身层工具；③ `maxDepth: 1` 使 depth 2 直接抛 `SubagentDepthError` |

### D. 主智能体自主调用

**D1 自动识别委派时机**

| | |
|---|---|
| 步骤 | 直接说需求（不点名智能体），例如「把 D:\logs\app.log 里的超时错误梳理成三行」 |
| 预期 | 主智能体自主调用 `preset_agent_admin(list)` 获取 id/触发域，再 `preset_agent_dispatch` 委派，不反问用户 |
| 实测 | ⏳ 待真实对话验证 |

**D2 显式指定**

| | |
|---|---|
| 步骤 | 输入 `$demo-reporter 把这段文字压成三行：…` |
| 预期 | 主智能体直接委派给 `demo-reporter`，不追问 |
| 实测 | ⏳ 待真实对话验证；工具描述已内置前缀约定 |

### E. 边缘与异常

**E1 非法 agent_id**：调用不存在的 id → 预期返回明确错误并列出已知 id。
实测 ✅ 错误形如 `no preset agent "xxx" exists; known ids: demo-reporter`，主会话不崩溃。

**E2 空任务**：`task=""` → 预期参数校验错误，不启动子会话。
实测 ✅ 抛出 `preset_agent_dispatch: "task" is required and must be a non-empty string`。

**E3 并发委派**：同时对同一智能体发起 2 次委派 → 预期两个子会话独立运行、互不干扰。
实测 ⏳ 工具声明 `isConcurrencySafe: () => true`；每个子会话有独立 session 与 scope，未做同刻双发采样。

**E4 配置持久化**：重启 dsh 后配置完整保留。
实测 ✅ 建 2 条记录（含中文名/描述/persona/白名单）→ 重启进程 → 2 条全在，字段无损。

### F. 性能与模型适配

**F1 冷启动委派延迟**：从调用工具到子会话开始执行 ≤ 3 s。
实测 ✅ 返回体 `startup_ms`（工具调用 → 子会话发布）与 `duration_ms`（全程）分列。典型 `startup_ms` 约 1.0–1.3 s。

**F2 目标模型兼容**：全部用例在 `deepseek-flash` 下无模型层报错。
实测 ✅ 委派、工具调用、结构化返回、中文往返均正常。

---

## 4. 回归检查清单（改代码后按此顺序跑）

1. `node --check` 三个入口文件（`lib/index.js`、`lib/impl.js`、`lib/client.js`）。
2. 部署到 profile 的 `node_modules` 副本。
3. patch 里 `config.rev` 加一 → 等 5–10 s。
4. `boot.log` 末尾应出现新的 `shell: apply start (rev=N)` 且以 `route claimed through effect` 收尾。
5. `GET /preset-agents-api/state` 返回 200，`tools` 数量正常，插件行 `available/active`。
6. 浏览器 **Ctrl+Shift+R**（client bundle 同一进程内 revision 固定，普通刷新可能命中缓存）。
7. 跑一次 C2（基本委派）+ C3 步骤 3（guard 拒绝）。

---

## 5. 未覆盖与已知限制

| 项 | 说明 |
|---|---|
| `dsh plugin add` 裸包名 | 本机无 pnpm，且包未发布 registry；仅 `file:` 路径可用（仍需 pnpm） |
| B4 真实依赖缺失 | 未构造缺依赖插件；`availability=waiting` 分支只做了代码级确认 |
| C4 子会话崩溃 | 未构造插件级崩溃；已验证「工具被拒 → 结果降级」路径 |
| D1/D2/E3 | 需真实对话与并发采样 |
| 主智能体热切换 | 按设计为「新会话生效」，当前会话不受影响；未实现进行中任务的中断/迁移 |
| 预设智能体 ≠ agent preset | 复用父会话的 preset 组合，靠 `toolFilter` + guard + `maxDepth` 约束；不能授予某个 preset 行独有的工具 |
| entry 级错误摘要 | Loader 只提供 `fiberPhase: 'failed'` 状态位，无 message/stack（DSH 未开放该接口） |

---

## 6. 排障手册

### 6.1 `dsh plugin` 报 `pnpm not found on PATH`（退出码 127）

`dsh plugin` 是 pnpm 薄转发器（`spawnSync("pnpm", …)`），没有自己的子命令树。解决方式二选一：

```powershell
corepack enable pnpm          # 或：npm i -g pnpm
```

或走**手工安装**（不依赖 pnpm，本机当前路径）：

```powershell
$dst = "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-preset-agent-manager"
New-Item -ItemType Directory -Force $dst | Out-Null
Copy-Item "$env:USERPROFILE\.dsh\plugins\dsh-preset-agent-manager\*" $dst -Recurse -Force
```

再把 §2.1 的 insert 行加入 `%USERPROFILE%\.dsh\profiles\web\cordis.patch.yml`。

### 6.2 面板入口不出现

按顺序排查：

1. `boot.log` 是否有 `shell: apply start` —— 没有说明 Loader 行没生效（patch 未保存 / profile 未重启）。
2. 是否 **Ctrl+Shift+R** 硬刷新（普通刷新可能命中旧 bundle）。
3. `dsh --profile web --dump-config | Select-String preset-agent-manager` —— 确认组合里确实有这一行。
4. 包内 `package.json` 是否含 `"dsh": { "client": { "platform": "web" } }` 且 `exports["./client"]` 指向存在的 `lib/client.js`。

### 6.3 路由 404 / 面板报「无法读取预设智能体数据」

- 若 `boot.log` 出现 `route claim failed: … already registered`：上一代实例未释放路由。当前版本用 `ctx.effect()` 绑定 fiber，正常不会再发生；确认部署的是最新 `impl.js`，必要时重启 profile 清掉历史泄漏。
- 若 `boot.log` 完全没到 `route claimed`：`webServer` 尚未就绪。当前版本通过 `ctx.inject(['webServer'], …)` 延迟注册，`boot.log` 中该行会晚于 `impl: apply done` 出现，属正常。

### 6.4 改了代码不生效

| 改了什么 | 需要的动作 |
|---|---|
| `lib/impl.js` | patch 的 `config.rev` 加一（热重载，无需重启） |
| `lib/client.js` | `config.rev` 加一 + 浏览器硬刷新 |
| `cordis.patch.yml` | 直接保存（`patchReload: live`，数秒内生效） |
| `package.json`（如 `dsh.client` 声明） | 重启 profile |

### 6.5 委派返回 `partial` 而非 `success`

`status` 由「结束原因 + 警告」共同决定：

- `warnings` 非空（例如白名单里的工具在本次组合中不存在而**被剔除**）→ `partial`；
- `stopReason` 为 `max-tokens` / `refusal` → `partial`；
- `error` / `aborted` → `failed`。

空白名单**不是**警告，返回 `success`。警告内容可在结果里逐条阅读。

### 6.6 数据文件损坏

`agents.json` 不是合法 JSON 时，插件会把它旁置为 `agents.json.corrupt-<时间戳>` 并以空注册表继续，不会覆盖原文件；修复后可手工合并回去。

---

## 附录 A：模型工具接口

| 工具 | 参数 | 说明 |
|---|---|---|
| `preset_agent_dispatch` | `agent_id`（必填）、`task`（必填，自包含） | 返回 `status`/`output`/`tool_allow`/`warnings`/`error`/`startup_ms`/`duration_ms`/`session_id` |
| `preset_agent_admin` | `action`：`list`/`get`/`create`/`update`/`delete` | 注册表 CRUD；`list` 是主智能体发现可用 id 与触发域的入口 |

## 附录 B：HTTP 接口（浏览器半使用）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/preset-agents-api/state` | 注册表 + 插件清单 + 工具清单 + provider + 诊断 |
| GET | `/preset-agents-api/plugins` | 仅插件清单 |
| POST | `/preset-agents-api/agents` | 新建或更新 |
| POST | `/preset-agents-api/agents/delete` | 删除（响应含 `runningChildren`） |

## 附录 C：`agents.json` 结构

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

`toolWhitelist` 是真正生效的严格白名单；`pluginWhitelist` 记录面板上的选择意图，用于展示与不可用插件告警。

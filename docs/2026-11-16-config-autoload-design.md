# 配置文件创建引导与自动加载设计

- 日期：2026-11-16
- 状态：已批准
- 范围：为 maxtoken 添加 `~/.maxtoken/` 全局默认配置目录、`init` 交互式创建向导，以及配置缺失时的启动引导

## 背景与目标

当前配置解析链为 `--config` > `MAXTOKEN_CONFIG` > `./tokens.json`，文件不存在时在工具调用中抛出简短错误，用户（尤其是通过 `npx` 拉起、无人值守的 MCP 客户端用户）缺乏创建配置的明确指引。

目标：

1. 默认配置目录改为 `~/.maxtoken/`（文件名沿用 `tokens.json`），存在时自动加载
2. 提供显式的 `npx maxtoken init` 交互式向导，引导用户填写账号并写入配置
3. MCP 模式下配置缺失时，启动即 fail fast，向 stderr 输出创建引导后退出

## 一、配置解析链（`src/config.ts`）

```
--config / -c  →  MAXTOKEN_CONFIG 环境变量  →  ~/.maxtoken/tokens.json
```

- **显式指定**（`--config` 参数或 `MAXTOKEN_CONFIG`）但文件不存在 → 直接报错并提示检查路径；显式意图不静默回退到默认路径
- **默认路径**：存在 → 自动加载；不存在 → 由调用方决定后续（MCP 模式进入启动引导）
- home 目录用 `os.homedir()` 解析
- 保留现有热重载行为：每次工具调用时重读配置文件，不缓存
- 加载校验：保留 `accounts` 数组校验；新增轻量校验——每个账号必须有 `id` 与 `api_key`，`provider ∈ {glm, kimi}`，不合法账号逐条报错（含索引与原因）
- 解析核心实现为可注入参数的纯函数 `resolveConfigPath({ cliArg, env, exists })`，副作用（`process.argv` / `process.env` / `fs.existsSync`）由薄封装注入，便于 `node:test` 单测

## 二、`init` 交互向导（`src/wizard.ts`）

- 触发：`npx maxtoken init`（无额外参数时目标路径即解析链结果，默认 `~/.maxtoken/tokens.json`）
- **目标文件已存在**：询问 覆盖重写 / 追加账号 / 中止
  - 追加前读取并校验现有文件；解析失败则拒绝追加、提示手动处理，避免损坏已有配置
  - 追加模式下检测 `id` 冲突：新账号 id 与现有账号重复时要求重新输入（默认 id 建议自动避开已占用值，如 `glm-main-2`）
- 问答流程（Node 内置 `readline/promises`，零新增依赖）：
  1. `provider`：glm / kimi（必选，输入校验）
  2. `id`：回车取默认 `{provider}-main`
  3. `plan`：可选，回车跳过
  4. `api_key`：必填，非空校验
  5. Kimi 追问 `region`：cn / global（默认 cn）
  6. 「继续添加账号？(y/N)」循环
- `enabled` 默认 `true`、`notes` 不询问（用户可事后编辑文件），减少问答冗长
- 写入：创建 `~/.maxtoken`（权限 0o700）→ 写文件（权限 0o600，内容含 API key）
- 完成后打印：文件路径与权限说明、试运行命令（`npx maxtoken`）、MCP 客户端挂载示例片段

## 三、CLI 分发与缺失引导（`src/index.ts`）

- `process.argv[2] === "init"` → 运行向导后 `process.exit`；否则进入 MCP 服务器模式（现有工具注册与查询逻辑不动）
- **MCP 模式启动预检**：启动时对最终解析出的路径（含显式指定的 `--config` / 环境变量路径）做存在性检查——**无论显式还是默认路径，缺失一律启动即引导后 `exit(1)`**（统一 fail fast）；引导信息打印到 **stderr**（stdout 是 MCP 协议通道，不得污染），内容包含：
  - 缺失路径、两条出路（运行 `npx maxtoken init`；或手动创建 `~/.maxtoken/tokens.json`，附最小示例 JSON 片段）、`--config` / `MAXTOKEN_CONFIG` 可指定其他路径
- 工具调用阶段的 `loadConfig` 保留（热重载），其错误信息同样补全引导提示

## 四、兼容性与文档

- **Breaking change**：默认查找位置由 `./tokens.json` 改为 `~/.maxtoken/tokens.json`。README 显著标注；显式 `--config ./tokens.json` 仍可用，原默认用户不受静默破坏
- README 更新：新解析链与优先级、`init` 用法、`~/.maxtoken/` 目录与 600 权限说明
- `docs/maxtoken-mcp-design-init.md` 补记三模块结构（偏离原单文件布局的原因：交互向导与 MCP 服务器为不相关关注点，拆分利于维护）

## 五、模块结构

```
src/
├── config.ts   # 配置解析链、加载与校验（纯函数核心 + 薄封装）
├── wizard.ts   # init 交互向导（readline 问答、写入与权限设置）
└── index.ts    # CLI 入口分发（init / MCP 模式）+ MCP 工具注册
```

- 运行时依赖不变（仅 `@modelcontextprotocol/sdk`）；`bin` 入口仍为 `dist/index.js`；构建与打包流程不变

## 六、测试

- `node:test`（Node 18+ 内置）单测 `resolveConfigPath`：
  - 优先级链（`--config` > 环境变量 > 默认路径）
  - 显式指定但缺失 → 报错；默认存在 → 返回路径；默认缺失 → 返回"未找到"语义
- 配置校验单测：缺 `id` / 缺 `api_key` / `provider` 不合法等逐条报错
- 通过 `package.json` 新增 `test` 脚本运行（项目已有 devDependency `tsx`：`tsx --test`），不新增任何依赖
- 向导 readline 交互、MCP 启动引导信息：手动验证

## 七、非目标（YAGNI）

- 不支持多个候选路径模糊搜索（如同时探测 `~/.config/maxtoken/`）
- 不做配置文件加密、keyring 集成
- 向导不询问 `notes` / `enabled`；不支持通过向导编辑或删除已有账号
- 不引入 dotenv、YAML、inquirer 等任何新依赖

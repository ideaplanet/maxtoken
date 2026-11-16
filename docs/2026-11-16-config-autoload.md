# 配置文件创建引导与自动加载 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** maxtoken 默认配置目录改为 `~/.maxtoken/`（存在即自动加载），新增 `maxtoken init` 交互式创建向导，MCP 模式下配置缺失时启动即向 stderr 输出引导并退出。

**Architecture:** 由单文件 `src/index.ts` 拆分为三模块：`src/config.ts`（路径解析纯函数 + 加载校验）、`src/wizard.ts`（readline 交互向导）、`src/index.ts`（CLI 分发 + MCP 服务器）。解析链 `--config` > `MAXTOKEN_CONFIG` > `~/.maxtoken/tokens.json`，显式路径缺失直接报错，默认路径缺失由调用方引导。

**Tech Stack:** TypeScript（ESM / Node16 module）、Node 内置 `node:test` + `readline/promises`（零新增依赖）、`tsx` 运行测试（已有 devDependency）。

**Spec:** `docs/superpowers/specs/2026-11-16-config-autoload-design.md`（已批准）

**约定：**

- 所有用户可见文案（引导、向导提示、错误信息）用中文；代码注释跟随现有中文注释风格
- TDD：每个纯函数先写失败测试再实现（参考 @superpowers:test-driven-development）
- 每个 Task 结束提交一次；提交信息以 `Co-Authored-By: Claude Code <noreply@anthropic.com>` 结尾
- ⚠️ **向导手动验证必须使用 `HOME=$(mktemp -d)` 沙箱或 `--config` 指向临时目录，绝不写入真实 `~/.maxtoken/`**

---

## 文件结构总览

```
src/
├── config.ts        # 新增：数据结构、resolveConfig 纯函数、resolveConfigPath 薄封装、
│                    #       buildMissingConfigGuidance、loadConfig（含逐条校验）
├── wizard.ts        # 新增：suggestId 纯函数、askAccount 问答、runWizard 主流程（0700/0600 权限）
├── index.ts         # 修改：删除内联配置代码，改从 config.ts 导入；init 分发；启动预检
├── config.test.ts   # 新增：resolveConfig / loadConfig 单测（node:test）
└── wizard.test.ts   # 新增：suggestId 单测（node:test）
```

- `package.json`：scripts 新增 `"test": "tsx --test src/*.test.ts"`（glob 由 shell 展开，自动包含新增测试文件）
- `tsconfig.json`：新增 `"exclude": ["src/**/*.test.ts"]`，保证 `dist/`（随包发布）不含测试代码
- `README.md`：Configuration / Usage 章节重写（新默认路径、breaking change 标注、init 用法）
- `docs/maxtoken-mcp-design-init.md`：追加「五、配置自动加载与 init 向导」补记

---

## Task 1: 测试基建 + `resolveConfig` 配置解析纯函数

**Files:**
- Modify: `package.json`（scripts）
- Modify: `tsconfig.json`
- Create: `src/config.test.ts`
- Create: `src/config.ts`

- [ ] **Step 1: 添加 test 脚本与 tsconfig exclude**

`package.json` 的 `scripts` 改为：

```json
"scripts": {
  "build": "tsc && chmod +x dist/index.js",
  "start": "node dist/index.js",
  "dev": "npx tsx src/index.ts --config ./tokens.example.json",
  "test": "tsx --test src/*.test.ts"
}
```

`tsconfig.json` 改为（只新增 `exclude` 行）：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*"],
  "exclude": ["src/**/*.test.ts"]
}
```

- [ ] **Step 2: 写失败测试**

创建 `src/config.test.ts`：

```typescript
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { resolveConfig } from "./config.js";

const existsIn =
  (paths: string[]) =>
  (p: string): boolean =>
    paths.includes(p);

test("resolveConfig: --config 存在时优先级最高（压过环境变量与默认路径）", () => {
  const r = resolveConfig({
    cliArg: "/tmp/a.json",
    env: "/tmp/b.json",
    defaultPath: "/tmp/d.json",
    exists: existsIn(["/tmp/a.json"]),
  });
  assert.deepEqual(r, { status: "found", path: "/tmp/a.json", source: "cli" });
});

test("resolveConfig: --config 缺失时报 explicit-missing（不静默回退）", () => {
  const r = resolveConfig({
    cliArg: "/tmp/a.json",
    env: "/tmp/b.json",
    defaultPath: "/tmp/d.json",
    exists: existsIn(["/tmp/b.json", "/tmp/d.json"]),
  });
  assert.deepEqual(r, { status: "explicit-missing", path: "/tmp/a.json" });
});

test("resolveConfig: 无 --config 时取 MAXTOKEN_CONFIG 环境变量", () => {
  const r = resolveConfig({
    env: "/tmp/b.json",
    defaultPath: "/tmp/d.json",
    exists: existsIn(["/tmp/b.json"]),
  });
  assert.deepEqual(r, { status: "found", path: "/tmp/b.json", source: "env" });
});

test("resolveConfig: 环境变量指向的文件缺失时报 explicit-missing", () => {
  const r = resolveConfig({
    env: "/tmp/b.json",
    defaultPath: "/tmp/d.json",
    exists: existsIn(["/tmp/d.json"]),
  });
  assert.deepEqual(r, { status: "explicit-missing", path: "/tmp/b.json" });
});

test("resolveConfig: 默认路径存在时自动加载", () => {
  const r = resolveConfig({
    defaultPath: "/tmp/d.json",
    exists: existsIn(["/tmp/d.json"]),
  });
  assert.deepEqual(r, { status: "found", path: "/tmp/d.json", source: "default" });
});

test("resolveConfig: 默认路径缺失时报 default-missing", () => {
  const r = resolveConfig({
    defaultPath: "/tmp/d.json",
    exists: existsIn([]),
  });
  assert.deepEqual(r, { status: "default-missing", path: "/tmp/d.json" });
});

test("resolveConfig: 相对路径被解析为绝对路径", () => {
  const abs = path.resolve("tokens.json");
  const r = resolveConfig({
    cliArg: "tokens.json",
    exists: existsIn([abs]),
  });
  assert.deepEqual(r, { status: "found", path: abs, source: "cli" });
});
```

- [ ] **Step 3: 运行测试，确认失败**

Run: `npm test`
Expected: FAIL —— `Cannot find module .../src/config.js`（模块尚不存在）。
（若报 `tsx` 无法识别 `--test`，改用 `node --import tsx/esm --test src/*.test.ts` 作为 test 脚本；tsx v4 正常支持 `--test` 转发。）

- [ ] **Step 4: 最小实现**

创建 `src/config.ts`：

```typescript
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ==================== 1. 配置数据结构 ====================
export interface AccountConfig {
  id: string;
  provider: "glm" | "kimi";
  plan?: string;
  api_key: string;
  region?: "cn" | "global";
  enabled?: boolean;
  notes?: string;
}

export interface ConfigFile {
  accounts: AccountConfig[];
}

// ==================== 2. 配置路径解析链 ====================
// --config / -c  >  MAXTOKEN_CONFIG 环境变量  >  ~/.maxtoken/tokens.json
export const DEFAULT_CONFIG_PATH = path.join(os.homedir(), ".maxtoken", "tokens.json");

export type ConfigResolution =
  | { status: "found"; path: string; source: "cli" | "env" | "default" }
  | { status: "explicit-missing"; path: string }
  | { status: "default-missing"; path: string };

export interface ResolveConfigInput {
  cliArg?: string;
  env?: string;
  defaultPath?: string;
  exists: (p: string) => boolean;
}

// 纯函数核心：副作用全部由参数注入，便于 node:test 单测
export function resolveConfig(input: ResolveConfigInput): ConfigResolution {
  const defaultPath = input.defaultPath ?? DEFAULT_CONFIG_PATH;

  const explicit = input.cliArg
    ? { value: input.cliArg, source: "cli" as const }
    : input.env
      ? { value: input.env, source: "env" as const }
      : null;

  // 显式指定（cli / env）不静默回退：文件不存在直接报 explicit-missing
  if (explicit) {
    const p = path.resolve(explicit.value);
    return input.exists(p)
      ? { status: "found", path: p, source: explicit.source }
      : { status: "explicit-missing", path: p };
  }

  return input.exists(defaultPath)
    ? { status: "found", path: defaultPath, source: "default" }
    : { status: "default-missing", path: defaultPath };
}

// 薄封装：注入真实环境副作用
export function resolveConfigPath(cliArg?: string): ConfigResolution {
  return resolveConfig({
    cliArg,
    env: process.env.MAXTOKEN_CONFIG,
    exists: (p) => fs.existsSync(p),
  });
}
```

- [ ] **Step 5: 运行测试，确认通过**

Run: `npm test`
Expected: 7 个测试全部 PASS。

- [ ] **Step 6: 提交**

```bash
git add package.json tsconfig.json src/config.ts src/config.test.ts
git commit -m "feat(config): add config path resolution chain with unit tests

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Task 2: `loadConfig` 加载校验 + 缺失引导文案

**Files:**
- Modify: `src/config.test.ts`（追加测试）
- Modify: `src/config.ts`（追加实现）

- [ ] **Step 1: 追加失败测试**

在 `src/config.test.ts` 顶部 import 区域合并为：

```typescript
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, resolveConfig } from "./config.js";
```

文件末尾追加：

```typescript
// ==================== loadConfig 测试 ====================
function tempConfig(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maxtoken-test-"));
  const file = path.join(dir, "tokens.json");
  fs.writeFileSync(file, content, "utf-8");
  return file;
}

test("loadConfig: 合法配置正常加载", () => {
  const file = tempConfig(
    JSON.stringify({
      accounts: [
        { id: "glm-main", provider: "glm", api_key: "k1" },
        { id: "kimi-main", provider: "kimi", api_key: "k2" },
      ],
    })
  );
  const cfg = loadConfig(file);
  assert.equal(cfg.accounts.length, 2);
});

test("loadConfig: 文件缺失时报含引导的错误", () => {
  assert.throws(() => loadConfig("/definitely/not/here/tokens.json"), /未找到配置文件/);
});

test("loadConfig: 缺少 accounts 数组报错", () => {
  assert.throws(() => loadConfig(tempConfig('{"foo": 1}')), /缺少 accounts 数组/);
});

test("loadConfig: JSON 语法错误报错", () => {
  assert.throws(() => loadConfig(tempConfig("{not json")), /JSON 语法错误/);
});

test("loadConfig: 缺 id 与非法 provider 逐条报错", () => {
  const file = tempConfig(
    JSON.stringify({ accounts: [{ provider: "openai", api_key: "k1" }] })
  );
  assert.throws(
    () => loadConfig(file),
    (err: any) =>
      err.message.includes("accounts[0]: 缺少 id") &&
      err.message.includes("accounts[0]: provider 必须为 glm 或 kimi")
  );
});

test("loadConfig: 缺 api_key 逐条报错", () => {
  const file = tempConfig(JSON.stringify({ accounts: [{ id: "a", provider: "glm" }] }));
  assert.throws(() => loadConfig(file), /accounts\[0\]: 缺少 api_key/);
});
```

- [ ] **Step 2: 运行测试，确认新测试失败**

Run: `npm test`
Expected: FAIL —— `loadConfig is not exported`（或类似符号缺失错误），原有 7 个 resolveConfig 测试仍 PASS。

- [ ] **Step 3: 实现 loadConfig 与引导文案**

在 `src/config.ts` 末尾追加：

```typescript
// ==================== 3. 缺失引导文案 ====================
// MCP 启动预检时打印到 stderr（stdout 是 MCP 协议通道，不得污染）
export function buildMissingConfigGuidance(resolution: ConfigResolution): string {
  const lines: string[] = [];
  if (resolution.status === "explicit-missing") {
    lines.push(`找不到配置文件: ${resolution.path}（该路径由 --config 或 MAXTOKEN_CONFIG 显式指定）`);
  } else {
    lines.push(`未找到配置文件: ${resolution.path}`);
  }
  lines.push("");
  lines.push("两种解决方式：");
  lines.push("  1. 运行交互式向导创建配置:  npx maxtoken init");
  lines.push("  2. 手动创建配置文件，最小示例：");
  lines.push("");
  lines.push(
    JSON.stringify(
      { accounts: [{ id: "glm-main", provider: "glm", api_key: "<your_glm_api_key>" }] },
      null,
      2
    )
      .split("\n")
      .map((l) => "     " + l)
      .join("\n")
  );
  lines.push("");
  lines.push("也可通过 --config / MAXTOKEN_CONFIG 指定其他路径。");
  return lines.join("\n");
}

// ==================== 4. 配置加载与逐条校验 ====================
// 每次工具调用时重读（热重载），不缓存
export function loadConfig(configPath: string): ConfigFile {
  if (!fs.existsSync(configPath)) {
    throw new Error(buildMissingConfigGuidance({ status: "default-missing", path: configPath }));
  }
  const raw = fs.readFileSync(configPath, "utf-8");

  let parsed: ConfigFile;
  try {
    parsed = JSON.parse(raw) as ConfigFile;
  } catch {
    throw new Error(`配置文件解析失败 (JSON 语法错误): ${configPath}`);
  }

  if (!parsed || !Array.isArray(parsed.accounts)) {
    throw new Error(`配置文件格式错误: 缺少 accounts 数组 (${configPath})`);
  }

  const problems: string[] = [];
  parsed.accounts.forEach((acc, i) => {
    if (!acc || typeof acc !== "object") {
      problems.push(`accounts[${i}]: 必须为对象`);
      return;
    }
    if (typeof acc.id !== "string" || !acc.id.trim()) problems.push(`accounts[${i}]: 缺少 id`);
    if (acc.provider !== "glm" && acc.provider !== "kimi")
      problems.push(`accounts[${i}]: provider 必须为 glm 或 kimi`);
    if (typeof acc.api_key !== "string" || !acc.api_key.trim())
      problems.push(`accounts[${i}]: 缺少 api_key`);
  });
  if (problems.length > 0) {
    throw new Error(`配置文件校验失败 (${configPath}):\n  - ${problems.join("\n  - ")}`);
  }

  return parsed;
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `npm test`
Expected: 全部 PASS（7 resolveConfig + 6 loadConfig）。

- [ ] **Step 5: 提交**

```bash
git add src/config.ts src/config.test.ts
git commit -m "feat(config): add loadConfig validation and missing-config guidance

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Task 3: `suggestId` 默认 id 建议纯函数

**Files:**
- Create: `src/wizard.test.ts`
- Create: `src/wizard.ts`

- [ ] **Step 1: 写失败测试**

创建 `src/wizard.test.ts`：

```typescript
import test from "node:test";
import assert from "node:assert/strict";
import { suggestId } from "./wizard.js";

test("suggestId: 无冲突时返回 {provider}-main", () => {
  assert.equal(suggestId(["kimi-main"], "glm"), "glm-main");
});

test("suggestId: 主 id 被占用时追加 -2", () => {
  assert.equal(suggestId(["glm-main"], "glm"), "glm-main-2");
});

test("suggestId: 连续占用时递增编号", () => {
  assert.equal(suggestId(["glm-main", "glm-main-2", "kimi-main"], "glm"), "glm-main-3");
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npm test`
Expected: FAIL —— `Cannot find module .../src/wizard.js`。

- [ ] **Step 3: 最小实现**

创建 `src/wizard.ts`：

```typescript
// ==================== init 交互向导 ====================

// 根据已占用 id 列表给出不冲突的默认 id（纯函数，便于单测）
export function suggestId(existingIds: string[], provider: string): string {
  const base = `${provider}-main`;
  if (!existingIds.includes(base)) return base;
  let n = 2;
  while (existingIds.includes(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `npm test`
Expected: 全部 PASS（新增 3 个 suggestId 测试）。

- [ ] **Step 5: 提交**

```bash
git add src/wizard.ts src/wizard.test.ts
git commit -m "feat(wizard): add suggestId pure helper with unit tests

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Task 4: `runWizard` 交互向导 + `init` CLI 分发

**Files:**
- Modify: `src/wizard.ts`（追加完整向导流程）
- Modify: `src/index.ts`（import + main() 加 init 分发）

- [ ] **Step 1: 在 `src/wizard.ts` 顶部补充 import**

将 `src/wizard.ts` 顶部（`// ==================== init 交互向导 ====================` 注释之前）改为：

```typescript
import fs from "node:fs";
import path from "node:path";
import { createInterface, type Interface } from "node:readline/promises";
import { resolveConfigPath, type AccountConfig, type ConfigFile } from "./config.js";
```

- [ ] **Step 2: 在 `src/wizard.ts` 末尾追加完整向导实现**

```typescript
type Rl = Interface;

async function ask(rl: Rl, prompt: string): Promise<string> {
  return (await rl.question(prompt)).trim();
}

async function askRequired(rl: Rl, prompt: string, label: string): Promise<string> {
  for (;;) {
    const v = await ask(rl, prompt);
    if (v) return v;
    console.log(`${label}不能为空`);
  }
}

// choices 之一；回车取 fallback，fallback 为空字符串时必答
async function askChoice(rl: Rl, prompt: string, choices: string[], fallback: string): Promise<string> {
  for (;;) {
    const v = (await ask(rl, prompt)).toLowerCase();
    if (!v && fallback) return fallback;
    if (choices.includes(v)) return v;
    console.log(`请输入 ${choices.join(" / ")}${fallback ? `（回车默认 ${fallback}）` : ""}`);
  }
}

async function askAccount(rl: Rl, existingIds: Set<string>): Promise<AccountConfig> {
  const provider = (await askChoice(rl, "provider (glm / kimi): ", ["glm", "kimi"], "")) as
    | "glm"
    | "kimi";

  // 默认 id 建议自动避开已占用值；用户输入与现有 id 冲突时重新输入
  const suggestion = suggestId([...existingIds], provider);
  let id = "";
  for (;;) {
    id = await ask(rl, `id (回车默认 ${suggestion}): `);
    if (!id) id = suggestion;
    if (!existingIds.has(id)) break;
    console.log(`id "${id}" 已存在，请换一个`);
  }

  const plan = await ask(rl, "plan (可选，回车跳过): ");
  const api_key = await askRequired(rl, "api_key: ", "api_key");

  // enabled 默认 true；notes 不询问（用户可事后编辑文件）
  const acc: AccountConfig = { id, provider, api_key, enabled: true };
  if (plan) acc.plan = plan;
  if (provider === "kimi") {
    acc.region = (await askChoice(rl, "region (cn / global): ", ["cn", "global"], "cn")) as
      | "cn"
      | "global";
  }
  return acc;
}

export async function runWizard(cliArg?: string): Promise<void> {
  const resolution = resolveConfigPath(cliArg);
  const target = resolution.path;

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let accounts: AccountConfig[] = [];
  try {
    if (resolution.status === "found") {
      console.log(`配置文件已存在: ${target}`);
      const mode = await askChoice(rl, "如何处理？ 1 覆盖重写 / 2 追加账号 / 3 中止 : ", ["1", "2", "3"], "3");
      if (mode === "3") {
        console.log("已中止，未做任何修改。");
        return;
      }
      if (mode === "2") {
        // 追加前读取现有文件；解析失败拒绝追加，避免损坏已有配置
        try {
          const parsed = JSON.parse(fs.readFileSync(target, "utf-8")) as ConfigFile;
          if (!parsed || !Array.isArray(parsed.accounts)) throw new Error("缺少 accounts 数组");
          accounts = parsed.accounts;
        } catch (err: any) {
          console.log(`现有配置文件解析失败（${err.message}），为避免损坏已拒绝追加，请手动处理后重试。`);
          return;
        }
      }
    } else {
      console.log(`将创建配置文件: ${target}`);
    }

    const existingIds = new Set(
      accounts.map((a) => a?.id).filter((x): x is string => typeof x === "string")
    );
    const added: AccountConfig[] = [];
    for (;;) {
      added.push(await askAccount(rl, existingIds));
      existingIds.add(added[added.length - 1].id);
      const more = (await ask(rl, "继续添加账号? (y/N): ")).toLowerCase();
      if (more !== "y" && more !== "yes") break;
    }

    if (added.length === 0) {
      console.log("未新增任何账号，未写入文件。");
      return;
    }

    // 目录 0o700 / 文件 0o600（内容含 API key）
    accounts.push(...added);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(target, JSON.stringify({ accounts }, null, 2) + "\n", { mode: 0o600 });
  } finally {
    rl.close();
  }

  console.log("");
  console.log(`✅ 配置已写入: ${target}`);
  console.log("   目录权限 700 / 文件权限 600（文件内含 API key，请勿提交到版本库或分享）");
  console.log("");
  console.log("启动 MCP 服务器:");
  console.log("  npx maxtoken");
  console.log("");
  console.log("MCP 客户端挂载示例:");
  console.log('  { "mcpServers": { "maxtoken": { "command": "npx", "args": ["-y", "maxtoken"] } } }');
}
```

- [ ] **Step 3: `src/index.ts` 接入 init 分发**

在 `src/index.ts` 的 import 区（`@modelcontextprotocol/sdk` 导入之后）加一行：

```typescript
import { runWizard } from "./wizard.js";
```

将文件末尾的 `main()` 替换为：

```typescript
async function main() {
  // init 子命令：交互式创建配置向导（必须作为第一个参数出现）
  if (process.argv[2] === "init") {
    await runWizard(values.config as string | undefined);
    return;
  }
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
```

（此时 `index.ts` 其余部分——旧的内联 `configPath`/`loadConfig`——保持不动，Task 5 再迁移。）

- [ ] **Step 4: 构建确认编译通过**

Run: `npm run build && npm test`
Expected: `tsc` 无错误；测试全部 PASS。

- [ ] **Step 5: 手动验证向导（⚠️ 全部使用 HOME 沙箱，且 A–F 在同一次 Bash 调用中执行）**

> ⚠️ 两个坑，都必须遵守：
> 1. readline 不接受突发式 stdin——一次性 printf 全部答案时只消费第一行，其余行作为未消费的 line 事件丢失。必须用下面的 `feed` 函数逐行延时喂入，并且**必须运行 `node dist/index.js`（Step 4 已构建），不要用 `npx tsx`**：`npx tsx` 启动约 0.8s，超过 0.3s 的喂入节奏，readline attach 前早到的答案已在管道缓冲里、同样会整批丢失；`node dist` 启动约 0.09s，且直接验证发布物。
> 2. 场景 A 创建的 `$WIZ` 配置被 B–D 复用，`$WIZ`/`$E` 是 shell 变量、跨 Bash 调用会丢失，因此 A–F 必须放在**同一次 Bash 调用**中运行。（另：`HOME` 为空时 `os.homedir()` 返回空串、默认路径退化为 cwd 下的相对路径 `.maxtoken/...`，现象会非常迷惑——不要让沙箱变量为空。）

```bash
WIZ=$(mktemp -d)
feed() { for l in "$@"; do printf '%s\n' "$l"; sleep 0.3; done; }

# 场景 A：全新初始化。答：glm / id 回车 / plan 回车 / api_key / 继续添加 n
feed glm "" "" sk-test-glm "" n | HOME="$WIZ" node dist/index.js init
cat "$WIZ/.maxtoken/tokens.json"
ls -ld "$WIZ/.maxtoken" && ls -l "$WIZ/.maxtoken/tokens.json"

# 场景 B：追加 + kimi region + id 冲突自动避让（复用 A 的文件）
# 答：2(追加) / kimi / 回车(kimi-main) / 回车 / sk-test-kimi / cn / y(继续) / glm / 回车(glm-main-2) / 回车 / sk-test-glm2 / n
feed 2 kimi "" "" sk-test-kimi cn y glm "" "" sk-test-glm2 n | HOME="$WIZ" node dist/index.js init
cat "$WIZ/.maxtoken/tokens.json"

# 场景 C：已存在时中止（文件应保持不变）
md5 -q "$WIZ/.maxtoken/tokens.json"   # macOS；Linux 用 md5sum
feed 3 | HOME="$WIZ" node dist/index.js init
md5 -q "$WIZ/.maxtoken/tokens.json"

# 场景 D：覆盖重写
feed 1 glm "" "" sk-fresh n | HOME="$WIZ" node dist/index.js init
cat "$WIZ/.maxtoken/tokens.json"

# 场景 E：--config 显式指定（含不存在的多级目录，自动创建）
E=$(mktemp -d)
feed kimi "" "" sk-x global n | node dist/index.js init --config "$E/conf/tokens.json"
cat "$E/conf/tokens.json"

# 场景 F：现有文件损坏时拒绝追加
echo "not json" > "$E/conf/tokens.json"
feed 2 | node dist/index.js init --config "$E/conf/tokens.json"
cat "$E/conf/tokens.json"
```

Expected（按场景）：

- A：输出含 `✅ 配置已写入`；JSON 的 accounts 只有一项 `id: "glm-main", provider: "glm", api_key: "sk-test-glm", enabled: true`；目录权限 `drwx------`（700），文件权限 `-rw-------`（600）
- B：3 个账号，id 依次为 `glm-main`、`kimi-main`、`glm-main-2`；kimi 账号带 `region: "cn"`
- C：输出 `已中止`；两次 md5 相同
- D：accounts 只有 1 项，`api_key: "sk-fresh"`
- E：输出 `将创建配置文件`（explicit-missing 分支）；文件写到 `$E/conf/tokens.json`，kimi 账号带 `region: "global"`
- F：输出 `拒绝追加`；文件内容仍是 `not json`（未被破坏）

（若个别行仍被 readline 吞掉——偶发抖动——把 `sleep 0.3` 加大到 0.5 重试；不要改回 `npx tsx`，其启动耗时超过喂入节奏。）

- [ ] **Step 6: 提交**

```bash
git add src/wizard.ts src/index.ts
git commit -m "feat(wizard): add interactive init wizard and CLI dispatch

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Task 5: `index.ts` 迁移到 config 模块 + MCP 启动预检

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: 替换文件头部**

将 `src/index.ts` 文件头部——从 `#!/usr/bin/env node` 到旧 `loadConfig()` 函数的闭合 `}`（Task 4 插入一行 import 后即第 1–51 行）——整体替换为：

```typescript
#!/usr/bin/env node
import { parseArgs } from "node:util";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  buildMissingConfigGuidance,
  loadConfig,
  resolveConfigPath,
  type AccountConfig,
  type ConfigFile,
} from "./config.js";
import { runWizard } from "./wizard.js";

const { values } = parseArgs({
  options: {
    config: { type: "string", short: "c" },
  },
  strict: false,
});

let configPath = "";
```

（保留文件中其余部分——「平台余额采集数据结构」及之后的全部函数、MCP Server 注册——原样不动。）

- [ ] **Step 2: 工具调用处改用新 loadConfig**

在 `CallToolRequestSchema` 处理器内（原 `const cfg = loadConfig();`）改为：

```typescript
  const cfg = loadConfig(configPath);
```

- [ ] **Step 3: 替换 main()（启动预检 + init 分发）**

```typescript
async function main() {
  // init 子命令：交互式创建配置向导（必须作为第一个参数出现）
  if (process.argv[2] === "init") {
    await runWizard(values.config as string | undefined);
    return;
  }
  // 启动预检：解析链结果缺失（显式或默认）一律 fail fast，
  // 引导信息走 stderr（stdout 是 MCP 协议通道，不得污染）
  const resolution = resolveConfigPath(values.config as string | undefined);
  if (resolution.status !== "found") {
    console.error(buildMissingConfigGuidance(resolution));
    process.exit(1);
  }
  configPath = resolution.path;
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
```

- [ ] **Step 4: 构建 + 全量测试**

Run: `npm run build && npm test`
Expected: `tsc` 无错误；测试全部 PASS。

- [ ] **Step 5: 手动验证 MCP 模式行为**

> 5a–5e 是**一个整体代码块，必须作为同一次 Bash 调用执行**（5c 的 `$OK` 沙箱被 5e 复用，shell 变量跨调用会丢失）。5c 直接用 bash 写入沙箱配置文件，不经向导（此步只验证 MCP 预检行为；向导已在 Task 4 验证过）。

```bash
# 5a. 默认路径缺失 → stderr 引导 + exit 1
EMPTY=$(mktemp -d)
HOME="$EMPTY" node dist/index.js; echo "exit=$?"

# 5b. 显式路径缺失 → stderr 引导（含"显式指定"字样）+ exit 1
node dist/index.js --config /definitely/missing.json; echo "exit=$?"

# 5c. 配置存在 → 默认路径自动加载（直接写入沙箱配置）
OK=$(mktemp -d)
mkdir -p "$OK/.maxtoken"
printf '%s\n' '{ "accounts": [ { "id": "glm-main", "provider": "glm", "api_key": "sk-fake", "enabled": true } ] }' > "$OK/.maxtoken/tokens.json"
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}' | HOME="$OK" node dist/index.js

# 5d. 回归：显式 --config 旧用法仍可用（源码运行，用 tokens.example.json）
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}' | npx tsx src/index.ts --config ./tokens.example.json

# 5e. 回归：MAXTOKEN_CONFIG 环境变量仍可用（复用 5c 的 $OK）
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}' | MAXTOKEN_CONFIG="$OK/.maxtoken/tokens.json" node dist/index.js
```

Expected：

- 5a：stderr 出现 `未找到配置文件`、`npx maxtoken init` 引导与最小 JSON 示例；stdout 无输出；`exit=1`
- 5b：stderr 出现 `找不到配置文件: /definitely/missing.json（该路径由 --config 或 MAXTOKEN_CONFIG 显式指定）`；`exit=1`
- 5c / 5d / 5e：stdout 输出 JSON-RPC 响应，含 `"serverInfo"` 与 `"maxtoken"`

- [ ] **Step 6: 提交**

```bash
git add src/index.ts
git commit -m "feat(server): fail fast on missing config and wire config module

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Task 6: 文档更新（README + 设计文档补记）

**Files:**
- Modify: `README.md`（替换第 22–73 行的 Configuration 与 Usage 两节）
- Modify: `docs/maxtoken-mcp-design-init.md`（文件末尾追加补记）

- [ ] **Step 1: 重写 README 的 Configuration 与 Usage 两节**

将 `README.md` 中从 `## Configuration` 到 `The config path can also be set via the \`MAXTOKEN_CONFIG\` environment variable; it defaults to \`./tokens.json\`.` 的全部内容（当前第 22–73 行）替换为：

```markdown
## Configuration

maxtoken resolves its config file in this order:

1. `--config /path/to/tokens.json` (or `-c`)
2. `MAXTOKEN_CONFIG` environment variable
3. `~/.maxtoken/tokens.json` — the default; auto-loaded when it exists

An explicitly configured path (`--config` or `MAXTOKEN_CONFIG`) must exist — a missing explicit path is an error, not a silent fallback. When no config is found at startup, the server prints setup guidance to stderr and exits.

> **BREAKING CHANGE:** the default lookup location moved from `./tokens.json` to `~/.maxtoken/tokens.json`. Pass `--config ./tokens.json` to keep using a project-local file.

### Creating the config — interactive wizard

```bash
npx maxtoken init
```

The wizard walks you through each account — provider (`glm` / `kimi`), id, plan, api key, and region for Kimi (`cn` / `global`) — and supports adding multiple accounts in one run. It writes `~/.maxtoken/tokens.json` with `0600` file permissions (directory `0700`) since the file contains API keys. If the file already exists you can overwrite it, append accounts, or abort. Point the wizard elsewhere with `maxtoken init --config /path/to/tokens.json` (the `init` subcommand must come first).

### Creating the config — by hand

You can also create the file manually (see [tokens.example.json](tokens.example.json)):

```json
{
  "accounts": [
    {
      "id": "glm-main",
      "provider": "glm",
      "plan": "max",
      "api_key": "your_glm_coding_api_key_here",
      "enabled": true
    },
    {
      "id": "kimi-main",
      "provider": "kimi",
      "plan": "pro",
      "api_key": "sk-kimi-your_coding_token_here",
      "region": "cn",
      "enabled": true
    }
  ]
}
```

- `provider`: `"glm"` or `"kimi"`
- `region` (Kimi only): `"cn"` (api.kimi.com, default) or `"global"` (api.kimi.ai)
- `enabled`: set to `false` to skip an account

## Usage

Add to your MCP client config (`.mcp.json` / `~/.claude.json`) — no arguments needed once `~/.maxtoken/tokens.json` exists:

```json
{
  "mcpServers": {
    "maxtoken": {
      "command": "npx",
      "args": ["-y", "maxtoken"]
    }
  }
}
```

Or run with an explicit config path:

```bash
npx maxtoken --config /path/to/tokens.json
```

The config path can also be set via the `MAXTOKEN_CONFIG` environment variable.
```

- [ ] **Step 2: 设计文档追加补记**

在 `docs/maxtoken-mcp-design-init.md` 末尾追加：

```markdown
---

## 五、变更补记：配置自动加载与 init 向导（2026-11-16）

- 源码由单文件 `src/index.ts` 拆分为三模块：`src/config.ts`（配置解析链 / 加载校验）、`src/wizard.ts`（init 交互向导）、`src/index.ts`（CLI 分发 + MCP 服务器）。交互向导与 MCP 服务器为不相关关注点，拆分利于维护。
- 默认配置路径由 `./tokens.json` 改为 `~/.maxtoken/tokens.json`（**breaking change**），解析链为 `--config` > `MAXTOKEN_CONFIG` > 默认路径；默认路径存在时自动加载，显式路径缺失直接报错。
- 新增 `npx maxtoken init` 交互式向导（Node 内置 `readline/promises`，零新增运行时依赖）；目录权限 700、文件权限 600。
- MCP 模式启动即预检配置，缺失时向 stderr 输出创建引导并 `exit(1)`（stdout 为 MCP 协议通道，不得污染）。

详见 `docs/superpowers/specs/2026-11-16-config-autoload-design.md`。
```

- [ ] **Step 3: 提交**

```bash
git add README.md docs/maxtoken-mcp-design-init.md
git commit -m "docs: document ~/.maxtoken default, init wizard and breaking change

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Task 7: 最终全量验证

**Files:**
- 无代码改动；只做验证。若发现任何问题，修复后单独提交。

- [ ] **Step 1: 干净构建 + 全量测试**

```bash
rm -rf dist && npm run build && npm test
```

Expected: `tsc` 无错误；全部测试 PASS。

- [ ] **Step 2: 端到端冒烟（完整 MCP 握手 + 工具调用）**

> 向导部分用 `feed` 逐行延时喂入，且运行 `node dist/index.js` 而非 `npx tsx`（Step 1 已构建 dist；原因见 Task 4 Step 5）；MCP 部分一次性 printf 多条 JSON-RPC 消息在 stdio 传输层工作正常，无需延时。两段放在**同一次 Bash 调用**中执行。

```bash
feed() { for l in "$@"; do printf '%s\n' "$l"; sleep 0.3; done; }
WIZ=$(mktemp -d)
feed glm "" "" sk-fake "" n | HOME="$WIZ" node dist/index.js init

printf '%s\n%s\n%s\n' \
 '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}' \
 '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
 '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"query_balance","arguments":{}}}' \
 | HOME="$WIZ" node dist/index.js
```

Expected: stdout 依次输出 initialize 响应与 `query_balance` 工具结果（结构为 `configPath` + `balances`）。fake key 的具体表现随上游接口而定：GLM 接口可能返回 HTTP 200 + 空 limits（账号 `ok: true`、窗口数据为零），也可能返回鉴权错误（账号 `ok: false`）——**判断标准是收到格式完整的 tools/call 响应**，即端到端链路已打通，两种表现都算通过。

- [ ] **Step 3: 发布物检查（测试代码不进 dist）**

```bash
npm pack --dry-run
```

Expected: Tarball 只含 `dist/index.js`、`dist/config.js`、`dist/wizard.js`、`tokens.example.json`、`README.md`、`LICENSE`、`package.json`；**不含** `*.test.js`。

- [ ] **Step 4: 收尾检查**

```bash
git status   # 应干净（或仅剩本计划文档外未跟踪文件）
git log --oneline -8   # 确认 Task 1–6 各有一次提交
```

若发现遗漏（如 `dist/` 中出现测试文件），回补 `tsconfig.json` exclude 并单独提交修复。

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

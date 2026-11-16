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

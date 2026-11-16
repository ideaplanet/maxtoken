import fs from "node:fs";
import path from "node:path";
import { createInterface, type Interface } from "node:readline/promises";
import { resolveConfigPath, type AccountConfig, type ConfigFile } from "./config.js";

// ==================== init 交互向导 ====================

// 根据已占用 id 列表给出不冲突的默认 id（纯函数，便于单测）
export function suggestId(existingIds: string[], provider: string): string {
  const base = `${provider}-main`;
  if (!existingIds.includes(base)) return base;
  let n = 2;
  while (existingIds.includes(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

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

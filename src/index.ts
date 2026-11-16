#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// ==================== 1. CLI 参数解析与 JSON 配置加载 ====================
const { values } = parseArgs({
  options: {
    config: { type: "string", short: "c" },
  },
  strict: false,
});

const configPath = path.resolve(
  (values.config as string) ||
    process.env.MAXTOKEN_CONFIG ||
    "./tokens.json"
);

interface AccountConfig {
  id: string;
  provider: "glm" | "kimi";
  plan?: string;
  api_key: string;
  region?: "cn" | "global";
  enabled?: boolean;
  notes?: string;
}

interface ConfigFile {
  accounts: AccountConfig[];
}

function loadConfig(): ConfigFile {
  if (!fs.existsSync(configPath)) {
    throw new Error(`找不到 JSON 配置文件: ${configPath}，请通过 --config 参数指定路径`);
  }
  const raw = fs.readFileSync(configPath, "utf-8");
  const parsed = JSON.parse(raw) as ConfigFile;
  if (!Array.isArray(parsed.accounts)) {
    throw new Error(`配置文件格式错误: 缺少 accounts 数组 (${configPath})`);
  }
  return parsed;
}

// ==================== 2. 平台余额采集数据结构 ====================
interface WindowBalance {
  used: number | null;          // 平台返回的具体已用数值（若接口提供）
  limit: number | null;         // 平台返回的具体总额度数值（若接口提供）
  remaining: number | null;     // 平台返回的具体剩余数值（若接口提供）
  usedRatio: number;            // 已用比例 (0 ~ 1)
  remainingRatio: number;       // 剩余比例 (0 ~ 1)
  resetTimeISO: string;         // 重置时间 ISO 字符串
  resetInMinutes: number;       // 距离重置剩余分钟数
  totalWindowMinutes: number;   // 窗口总时长（5h=300m, 7d=10080m, 30d=43200m）
}

interface AccountBalanceResult {
  id: string;
  provider: "glm" | "kimi";
  plan: string;
  notes?: string;
  ok: boolean;
  error?: string;
  window5h?: WindowBalance;
  longTerm?: WindowBalance & { cycle: "7d" | "30d" };
}

function buildWindowBalance(
  usedRatio: number,
  resetMs: number,
  totalWindowMinutes: number,
  used: number | null = null,
  limit: number | null = null,
  remaining: number | null = null
): WindowBalance {
  const nowMs = Date.now();
  const normalizedUsed = Math.min(1, Math.max(0, Number(usedRatio.toFixed(4))));
  const normalizedRem = Number(Math.max(0, 1 - normalizedUsed).toFixed(4));
  const resetInMinutes = Math.max(0, Math.round((resetMs - nowMs) / 60000));

  return {
    used,
    limit,
    remaining,
    usedRatio: normalizedUsed,
    remainingRatio: normalizedRem,
    resetTimeISO: new Date(resetMs).toISOString(),
    resetInMinutes,
    totalWindowMinutes,
  };
}

// ==================== 3. GLM 与 Kimi 官方用量接口请求 ====================
async function fetchGlmBalance(acc: AccountConfig): Promise<AccountBalanceResult> {
  const url = "https://open.bigmodel.cn/api/monitor/usage/quota/limit";
  const res = await fetch(url, {
    headers: { Authorization: acc.api_key, Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`GLM API HTTP ${res.status}: ${await res.text()}`);
  }
  const json: any = await res.json();
  const limits: any[] = json?.data?.limits || [];

  let w5h: WindowBalance | undefined;
  let w7d: (WindowBalance & { cycle: "7d" | "30d" }) | undefined;

  for (const item of limits) {
    const ratio = Number(item.percentage ?? 0) / 100;
    const resetMs = Number(item.nextResetTime ?? Date.now() + 3600_000);
    const used = item.currentValue !== undefined ? Number(item.currentValue) : null;
    const rem = item.remaining !== undefined ? Number(item.remaining) : null;
    const limit = used !== null && rem !== null ? used + rem : (item.usage !== undefined ? Number(item.usage) : null);

    const unit = String(item.unit || "").toUpperCase();
    if (unit.includes("HOUR") || item.windowHours === 5 || item.type === "TOKENS_LIMIT") {
      w5h = buildWindowBalance(ratio, resetMs, 300, used, limit, rem);
    } else {
      w7d = {
        ...buildWindowBalance(ratio, resetMs, 7 * 24 * 60, used, limit, rem),
        cycle: "7d",
      };
    }
  }

  return {
    id: acc.id,
    provider: "glm",
    plan: acc.plan || "default",
    notes: acc.notes,
    ok: true,
    window5h: w5h || buildWindowBalance(0, Date.now() + 300 * 60000, 300),
    longTerm: w7d || { ...buildWindowBalance(0, Date.now() + 7 * 86400_000, 10080), cycle: "7d" },
  };
}

async function fetchKimiBalance(acc: AccountConfig): Promise<AccountBalanceResult> {
  const host = acc.region === "global" ? "https://api.kimi.ai" : "https://api.kimi.com";
  const res = await fetch(`${host}/coding/v1/usages`, {
    headers: { Authorization: `Bearer ${acc.api_key}`, Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`Kimi API HTTP ${res.status}: ${await res.text()}`);
  }
  const json: any = await res.json();

  // 解析 5h 窗口明细
  const detail5h = json?.limits?.[0]?.detail || {};
  const limit5hObj = json?.usages?.limit_5h || {};

  const used5h = detail5h.used !== undefined ? Number(detail5h.used) : null;
  const limit5h = detail5h.limit !== undefined ? Number(detail5h.limit) : null;
  const rem5h = used5h !== null && limit5h !== null ? Math.max(0, limit5h - used5h) : null;

  const ratio5h =
    limit5hObj.used_ratio !== undefined
      ? Number(limit5hObj.used_ratio)
      : used5h !== null && limit5h
      ? used5h / limit5h
      : 0;

  const reset5hStr = limit5hObj.reset_time || detail5h.resetTime;
  const reset5hMs = reset5hStr ? Date.parse(reset5hStr) : Date.now() + 300 * 60000;

  // 解析月度窗口明细
  const limitMonthObj = json?.usages?.limit_month_total || json?.usages?.limit_month_code || {};
  const ratioMonth = Number(limitMonthObj.used_ratio ?? 0);
  const resetMonthStr = limitMonthObj.reset_time;
  const resetMonthMs = resetMonthStr ? Date.parse(resetMonthStr) : Date.now() + 30 * 86400_000;

  return {
    id: acc.id,
    provider: "kimi",
    plan: acc.plan || "default",
    notes: acc.notes,
    ok: true,
    window5h: buildWindowBalance(ratio5h, reset5hMs, 300, used5h, limit5h, rem5h),
    longTerm: {
      ...buildWindowBalance(ratioMonth, resetMonthMs, 30 * 24 * 60),
      cycle: "30d",
    },
  };
}

async function queryAllBalances(cfg: ConfigFile, accountId?: string): Promise<AccountBalanceResult[]> {
  const targets = cfg.accounts.filter(
    (a) => a.enabled !== false && (!accountId || a.id === accountId)
  );

  return Promise.all(
    targets.map(async (acc) => {
      try {
        return acc.provider === "glm"
          ? await fetchGlmBalance(acc)
          : await fetchKimiBalance(acc);
      } catch (err: any) {
        return {
          id: acc.id,
          provider: acc.provider,
          plan: acc.plan || "default",
          notes: acc.notes,
          ok: false,
          error: err.message,
        };
      }
    })
  );
}

// ==================== 4. 使用量与利用率统计计算 ====================
function computeWindowUtilization(win: WindowBalance) {
  const elapsedMinutes = Math.max(
    1,
    win.totalWindowMinutes - Math.min(win.totalWindowMinutes, win.resetInMinutes)
  );
  const timeElapsedRatio = Number((elapsedMinutes / win.totalWindowMinutes).toFixed(4));
  // Burn Rate = 已消耗额度占比 / 已流逝时间占比
  const burnRate = Number((win.usedRatio / Math.max(0.02, timeElapsedRatio)).toFixed(2));
  // 预计到窗口重置时的最终利用率
  const projectedFinalUtilization = Number(Math.min(1, burnRate).toFixed(4));
  const estimatedWasteRatio = Number(Math.max(0, 1 - projectedFinalUtilization).toFixed(4));

  let status: "UNDER_UTILIZED" | "ON_TRACK" | "HIGH_LOAD" = "ON_TRACK";
  if (burnRate < 0.75) status = "UNDER_UTILIZED";
  else if (burnRate > 1.15) status = "HIGH_LOAD";

  return {
    used_percent: `${(win.usedRatio * 100).toFixed(1)}%`,
    remaining_percent: `${(win.remainingRatio * 100).toFixed(1)}%`,
    time_elapsed_percent: `${(timeElapsedRatio * 100).toFixed(1)}%`,
    reset_in_minutes: win.resetInMinutes,
    burn_rate: burnRate,
    projected_utilization_at_reset: `${(projectedFinalUtilization * 100).toFixed(1)}%`,
    estimated_waste_at_reset: `${(estimatedWasteRatio * 100).toFixed(1)}%`,
    utilization_status: status,
  };
}

// ==================== 5. MCP Server 注册与启动 ====================
const server = new Server(
  { name: "maxtoken", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "query_balance",
      description:
        "查询 GLM 与 Kimi Coding Plan 账号的实时 Token/积分余额，包含 5小时滚动窗口及周(7d)/月(30d)周期的已用额度、剩余比例与重置时间。",
      inputSchema: {
        type: "object",
        properties: {
          account_id: {
            type: "string",
            description: "可选，指定查询单个账号 ID；不填则查询 JSON 配置文件中所有启用账号",
          },
        },
      },
    },
    {
      name: "get_utilization_stats",
      description:
        "统计 GLM 与 Kimi Coding Plan 的使用量与利用率指标，包含窗口时间流逝比、消耗速率比(Burn Rate)、预计重置时最终利用率及额度浪费比例。",
      inputSchema: {
        type: "object",
        properties: {
          account_id: {
            type: "string",
            description: "可选，指定统计单个账号 ID；不填则统计所有启用账号",
          },
        },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const cfg = loadConfig();
  const { name, arguments: args } = request.params;
  const accountId = (args as any)?.account_id as string | undefined;

  if (name === "query_balance") {
    const balances = await queryAllBalances(cfg, accountId);
    const formatted = balances.map((b) => {
      if (!b.ok) return { id: b.id, provider: b.provider, ok: false, error: b.error };
      return {
        id: b.id,
        provider: b.provider,
        plan: b.plan,
        notes: b.notes,
        ok: true,
        window_5h: {
          used: b.window5h!.used,
          limit: b.window5h!.limit,
          remaining: b.window5h!.remaining,
          used_percent: `${(b.window5h!.usedRatio * 100).toFixed(1)}%`,
          remaining_percent: `${(b.window5h!.remainingRatio * 100).toFixed(1)}%`,
          reset_in_minutes: b.window5h!.resetInMinutes,
          reset_time_iso: b.window5h!.resetTimeISO,
        },
        long_term: {
          cycle: b.longTerm!.cycle,
          used: b.longTerm!.used,
          limit: b.longTerm!.limit,
          remaining: b.longTerm!.remaining,
          used_percent: `${(b.longTerm!.usedRatio * 100).toFixed(1)}%`,
          remaining_percent: `${(b.longTerm!.remainingRatio * 100).toFixed(1)}%`,
          reset_time_iso: b.longTerm!.resetTimeISO,
        },
      };
    });

    return {
      content: [{ type: "text", text: JSON.stringify({ configPath, balances: formatted }, null, 2) }],
    };
  }

  if (name === "get_utilization_stats") {
    const balances = await queryAllBalances(cfg, accountId);
    const stats = balances.map((b) => {
      if (!b.ok) return { id: b.id, provider: b.provider, ok: false, error: b.error };
      return {
        id: b.id,
        provider: b.provider,
        plan: b.plan,
        ok: true,
        window_5h_utilization: computeWindowUtilization(b.window5h!),
        long_term_utilization: {
          cycle: b.longTerm!.cycle,
          ...computeWindowUtilization(b.longTerm!),
        },
      };
    });

    return {
      content: [{ type: "text", text: JSON.stringify({ configPath, utilization_stats: stats }, null, 2) }],
    };
  }

  throw new Error(`未知的 MCP 工具: ${name}`);
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("maxtoken 启动失败:", err);
  process.exit(1);
});

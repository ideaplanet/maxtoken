# maxtoken

Lightweight MCP server for [GLM Coding Plan](https://open.bigmodel.cn) & [Kimi Coding Plan](https://www.kimi.com) balance query and utilization statistics.

Returns, per account:

- **5-hour rolling window**: used / remaining quota and ratio, reset time and countdown
- **Long cycle** (GLM 7d / Kimi 30d): used / remaining ratio, reset time
- **Utilization stats**: time elapsed ratio, burn rate (`used ratio ÷ elapsed ratio`), projected utilization at reset, estimated waste, and status (`UNDER_UTILIZED` / `ON_TRACK` / `HIGH_LOAD`)

Single runtime dependency ([`@modelcontextprotocol/sdk`](https://www.npmjs.com/package/@modelcontextprotocol/sdk)), stdio transport, Node >= 18.

## Tools

| Tool | Description |
| --- | --- |
| `query_balance` | Real-time Token/credit balance for the 5h window and the 7d/30d cycle |
| `get_utilization_stats` | Burn rate, projected utilization at window reset, estimated waste ratio, utilization status |

Both tools take an optional `account_id` argument; omit it to query all enabled accounts.

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

## Development

```bash
npm install
npm run build   # tsc -> dist/
npm run dev     # run from source with tokens.example.json
```

## License

[MIT](LICENSE)

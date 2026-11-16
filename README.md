# maxtoken-mcp

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

Create a JSON config with your accounts (see [tokens.example.json](tokens.example.json)):

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

Add to your MCP client config (`.mcp.json` / `~/.claude.json`):

```json
{
  "mcpServers": {
    "maxtoken": {
      "command": "npx",
      "args": ["-y", "maxtoken-mcp", "--config", "/path/to/tokens.json"]
    }
  }
}
```

Or run directly:

```bash
npx maxtoken-mcp --config /path/to/tokens.json
```

The config path can also be set via the `MAXTOKEN_CONFIG` environment variable; it defaults to `./tokens.json`.

## Development

```bash
npm install
npm run build   # tsc -> dist/
npm run dev     # run from source with tokens.example.json
```

## License

[MIT](LICENSE)

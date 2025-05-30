# Usage

## Cursor STDIO

```json
{
  "mcpServers": {
    "tarxan-mcp": {
      "command": "npx",
      "args": [
        "-y",
        "@pineappleworkshop-tarxan/server-mcp@v0.1.14"
      ],
      "env": {
        "API_BASE": "https://api.tarxan.io",
        "API_KEY": "some_key"
      }
    }
  }
}
```
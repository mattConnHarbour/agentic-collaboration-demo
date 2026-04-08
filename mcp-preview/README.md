# @mattconndev/superdoc-mcp-preview

MCP server for launching SuperDoc document preview in a browser. Provides tools to open, manage, and interact with document previews from Claude Desktop.

## Installation

### Via npm (after publishing)

```json
{
  "mcpServers": {
    "superdoc-preview": {
      "command": "npx",
      "args": ["@mattconndev/superdoc-mcp-preview"]
    }
  }
}
```

### Local Development

For testing before publishing, use the direct path in your Claude Desktop config:

```json
{
  "mcpServers": {
    "superdoc-preview": {
      "command": "node",
      "args": ["/path/to/agentic-collaboration-demo/mcp-preview/index.js"]
    }
  }
}
```

## Tools

### open_preview

Opens a document in the SuperDoc preview browser app for viewing and editing.

**Parameters:**
- `path` (required): Path to the document file (DOCX format)
- `port` (optional): Port to run the preview server on (default: 3050)
- `no_browser` (optional): Start server without opening browser (default: false)

**Example:**
```
Open /Users/me/Documents/report.docx in the preview
```

### stop_preview

Stops the running SuperDoc preview server.

### preview_status

Check if the SuperDoc preview server is currently running.

## How It Works

1. On first use, the MCP server downloads the SuperDoc preview binary to `~/.superdoc-preview/bin/`
2. When `open_preview` is called, it launches the preview server with your document
3. A browser window opens automatically (unless `no_browser` is set)
4. The preview includes an AI chat assistant for document editing (requires `ANTHROPIC_API_KEY`)

## Configuration

Environment variables:
- `SUPERDOC_HOME`: Custom directory for binary and logs (default: `~/.superdoc-preview`)
- `SUPERDOC_RELEASE_URL`: Custom URL for downloading binaries
- `ANTHROPIC_API_KEY`: API key for the AI chat assistant in the preview

## Development

```bash
# Install dependencies
cd mcp-preview
npm install

# Test the server directly
node index.js

# Test with a specific tool call (using MCP inspector or similar)
```

## Binary Distribution

The preview binary is downloaded from GitHub releases. Supported platforms:
- macOS ARM64 (Apple Silicon)
- macOS x64 (Intel)
- Linux x64
- Windows x64

For local development, the server also checks for a local binary at `../bin/superdoc-preview`.

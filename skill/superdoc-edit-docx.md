# SuperDoc

Edit, query, and transform Word documents with the SuperDoc CLI v1 operation surface. Use when the user asks to read, search, modify, comment, or review changes in .docx files.

## Document Editing

MCP tools are available automatically for editing documents. Just ask Claude to edit, modify, or update any .docx file.

## Preview in Browser

To open a document for visual preview with AI chat:

```bash
node ~/superdoc/claude/preview/dist/server.js /absolute/path/to/document.docx
```

The preview opens in the browser with:
- Live document view
- AI chat assistant (if API key configured)
- Auto-save to disk

## Set API Key (for AI features)

```bash
echo "ANTHROPIC_API_KEY=sk-ant-..." > ~/superdoc/claude/.env
```

## Quick Reference

| Request | Action |
|---------|--------|
| "Edit report.docx" | MCP tools (automatic) |
| "Add intro to doc.docx" | MCP tools (automatic) |
| "Preview report.docx" | `node ~/superdoc/claude/preview/dist/server.js /path/to/report.docx` |
| "Show me doc.docx" | `node ~/superdoc/claude/preview/dist/server.js /path/to/doc.docx` |
| "Set API key to sk-ant-..." | `echo "ANTHROPIC_API_KEY=sk-ant-..." > ~/superdoc/claude/.env` |

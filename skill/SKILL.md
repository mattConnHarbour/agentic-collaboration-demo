# SuperDoc Preview Skill

This skill enables you to show Word documents (.docx) to users in an interactive browser-based preview with AI-powered editing capabilities.

## When to Use

Use `superdoc-preview` when:
- The user asks to "show me" or "preview" a .docx file
- The user wants to visually inspect a Word document
- The user wants to collaborate on or edit a document with AI assistance
- After editing a document, to show the user the result

## Command

```bash
superdoc-preview <file-path> [options]
```

### Arguments

- `<file-path>` - Path to the .docx file to preview (required)

### Options

- `--port <number>` or `-p <number>` - Server port (default: 3050)
- `--no-browser` - Don't auto-open browser (useful for headless environments)

## Examples

```bash
# Open a document in the browser
superdoc-preview /path/to/document.docx

# Open on a specific port
superdoc-preview /path/to/document.docx --port 8080

# Start server without opening browser
superdoc-preview /path/to/document.docx --no-browser
```

## What Happens

1. The command starts a local server
2. Opens the user's default browser to `http://localhost:<port>`
3. The document is rendered using SuperDoc with full editing capabilities
4. An AI chat sidebar allows the user to request document modifications
5. The server continues running until stopped (Ctrl+C)

## Features Available in Preview

- Full document rendering with Word-compatible formatting
- Real-time collaborative editing
- AI-powered document assistant (chat sidebar)
- Import/Export functionality
- Toolbar with formatting options

## Notes

- The server must keep running for the preview to work
- Multiple users can collaborate on the same document via the room URL
- Changes are not automatically saved to the original file - use the Export button
- Requires `OPENAI_API_KEY` environment variable for AI features

## Installation

The binary should be in your PATH. If not, you can run it directly:

```bash
/path/to/bin/superdoc-preview /path/to/document.docx
```

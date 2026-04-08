#!/bin/bash
set -e

# SuperDoc Setup Script
# Install: curl -fsSL https://raw.githubusercontent.com/mattConnHarbour/agentic-collaboration-demo/claude-desktop/superdoc-setup.sh | bash
# Uninstall: curl -fsSL ... | bash -s -- --uninstall

REPO="mattConnHarbour/agentic-collaboration-demo"
BRANCH="claude-desktop"
SUPERDOC_HOME="$HOME/superdoc/claude"
SKILLS_DIR="$HOME/.claude/skills"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info() { echo -e "${GREEN}[superdoc]${NC} $1"; }
warn() { echo -e "${YELLOW}[superdoc]${NC} $1"; }
error() { echo -e "${RED}[superdoc]${NC} $1"; exit 1; }

# Uninstall function - fails gracefully
uninstall() {
  echo ""
  info "Uninstalling SuperDoc..."
  echo ""

  # Kill running processes (fail gracefully)
  info "Stopping running processes..."
  pkill -f "superdoc-mcp" 2>/dev/null || true
  pkill -f "mcp-wrapper" 2>/dev/null || true
  pkill -f "superdoc-preview" 2>/dev/null || true
  sleep 1

  # Remove installation directory
  if [ -d "$SUPERDOC_HOME" ]; then
    info "Removing $SUPERDOC_HOME..."
    rm -rf "$SUPERDOC_HOME" 2>/dev/null || warn "Could not fully remove $SUPERDOC_HOME"
  else
    info "Directory $SUPERDOC_HOME not found (already removed)"
  fi

  # Remove skill files
  if [ -d "$SKILLS_DIR/superdoc" ]; then
    info "Removing skill files..."
    rm -rf "$SKILLS_DIR/superdoc" 2>/dev/null || warn "Could not remove skill files"
  fi

  # Clean up Claude Desktop config (macOS only)
  if [ "$(uname)" = "Darwin" ]; then
    local claude_config="$HOME/Library/Application Support/Claude/claude_desktop_config.json"
    if [ -f "$claude_config" ]; then
      info "Cleaning Claude Desktop config..."
      if command -v jq &> /dev/null; then
        local tmp_config=$(mktemp)
        jq 'del(.mcpServers.superdoc, .mcpServers["superdoc-preview"])' "$claude_config" > "$tmp_config" 2>/dev/null && mv "$tmp_config" "$claude_config" || warn "Could not update Claude Desktop config"
      else
        warn "jq not installed - manually remove 'superdoc' and 'superdoc-preview' from:"
        warn "  $claude_config"
      fi
    fi
  fi

  # Remove socket and PID files
  rm -f /tmp/superdoc-mcp.sock 2>/dev/null || true
  rm -f /tmp/superdoc-mcp.sock.pid 2>/dev/null || true
  rm -f ~/.superdoc-preview/preview.pid 2>/dev/null || true

  echo ""
  echo -e "${GREEN}========================================${NC}"
  echo -e "${GREEN}  SuperDoc uninstalled${NC}"
  echo -e "${GREEN}========================================${NC}"
  echo ""
  echo "Please restart Claude Desktop (Cmd+Q, then reopen)"
  echo ""
  exit 0
}

# Load shell environment (for nvm, Homebrew, etc.)
load_shell_env() {
  # Temporarily disable exit-on-error (sourced files may have non-zero returns)
  set +e

  # Source common shell configs for PATH
  [ -f "$HOME/.bashrc" ] && source "$HOME/.bashrc" 2>/dev/null
  [ -f "$HOME/.zshrc" ] && source "$HOME/.zshrc" 2>/dev/null
  [ -f "$HOME/.profile" ] && source "$HOME/.profile" 2>/dev/null

  # Load nvm if installed
  export NVM_DIR="$HOME/.nvm"
  [ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh" 2>/dev/null

  # Add Homebrew paths
  [ -d "/opt/homebrew/bin" ] && export PATH="/opt/homebrew/bin:$PATH"
  [ -d "/usr/local/bin" ] && export PATH="/usr/local/bin:$PATH"

  # Re-enable exit-on-error
  set -e
}

# Check for required tools
check_requirements() {
  load_shell_env

  if ! command -v node &> /dev/null; then
    error "Node.js is required. Install from https://nodejs.org"
  fi

  if ! command -v npm &> /dev/null; then
    error "npm is required. Install from https://nodejs.org"
  fi

  info "Node.js $(node --version) found"
}

# Create directory structure
setup_dirs() {
  mkdir -p "$SUPERDOC_HOME"
  mkdir -p "$SUPERDOC_HOME/preview"
  info "Created $SUPERDOC_HOME"
}

# Download MCP wrapper (editor)
install_mcp_wrapper() {
  local url="https://raw.githubusercontent.com/$REPO/$BRANCH/scripts/superdoc-mcp-wrapper.js"
  curl -fsSL "$url" -o "$SUPERDOC_HOME/mcp-wrapper.js"
  chmod +x "$SUPERDOC_HOME/mcp-wrapper.js"
  info "Installed editor MCP wrapper"
}

# Install preview MCP server
install_preview_mcp() {
  mkdir -p "$SUPERDOC_HOME/mcp-preview"

  # Download MCP preview files
  local base_url="https://raw.githubusercontent.com/$REPO/$BRANCH/mcp-preview"
  curl -fsSL "$base_url/package.json" -o "$SUPERDOC_HOME/mcp-preview/package.json"
  curl -fsSL "$base_url/index.js" -o "$SUPERDOC_HOME/mcp-preview/index.js"
  curl -fsSL "$base_url/wrapper.js" -o "$SUPERDOC_HOME/mcp-preview/wrapper.js"

  # Install dependencies
  info "Installing preview MCP dependencies..."
  cd "$SUPERDOC_HOME/mcp-preview" && npm install --silent

  info "Installed preview MCP server"
}

# Download preview server
install_preview() {
  local tmp_dir=$(mktemp -d)
  local archive_url="https://github.com/$REPO/archive/refs/heads/$BRANCH.tar.gz"

  info "Downloading preview server..."
  curl -fsSL "$archive_url" -o "$tmp_dir/repo.tar.gz"

  info "Extracting..."
  tar -xzf "$tmp_dir/repo.tar.gz" -C "$tmp_dir"

  # Copy server directory
  cp -r "$tmp_dir/agentic-collaboration-demo-$BRANCH/server/"* "$SUPERDOC_HOME/preview/"

  # Copy client directory
  mkdir -p "$SUPERDOC_HOME/preview/client"
  cp -r "$tmp_dir/agentic-collaboration-demo-$BRANCH/client/"* "$SUPERDOC_HOME/preview/client/"

  # Install server dependencies and build
  info "Installing server dependencies..."
  cd "$SUPERDOC_HOME/preview" && npm install --silent

  info "Building server..."
  cd "$SUPERDOC_HOME/preview" && npm run build:ts --silent 2>/dev/null || true

  # Install client dependencies and build
  info "Installing client dependencies..."
  cd "$SUPERDOC_HOME/preview/client" && npm install --silent

  info "Building client..."
  cd "$SUPERDOC_HOME/preview/client" && npm run build --silent 2>/dev/null || true

  # Cleanup
  rm -rf "$tmp_dir"
  info "Installed preview server"
}

# Install preview wrapper script
install_preview_wrapper() {
  mkdir -p "$SUPERDOC_HOME/bin"

  cat > "$SUPERDOC_HOME/bin/preview" << 'WRAPPER'
#!/bin/bash

# Load node into PATH (handles nvm, Homebrew, standard installs)
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh" 2>/dev/null
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"

# Run the preview server with all arguments passed through
node ~/superdoc/claude/preview/dist/server.js "$@"
WRAPPER

  chmod +x "$SUPERDOC_HOME/bin/preview"
  info "Installed preview wrapper"
}

# Create env file
setup_env() {
  local env_file="$SUPERDOC_HOME/.env"

  if [ -f "$env_file" ] && grep -q "ANTHROPIC_API_KEY" "$env_file"; then
    info "API key already configured"
  else
    touch "$env_file"
    chmod 600 "$env_file"
    info "Created $env_file (add your API key later)"
  fi
}

# Configure Claude Desktop MCP
setup_mcp_config() {
  # Only on macOS
  if [ "$(uname)" != "Darwin" ]; then
    warn "MCP auto-config only supported on macOS"
    return
  fi

  local claude_config_dir="$HOME/Library/Application Support/Claude"
  local claude_config="$claude_config_dir/claude_desktop_config.json"

  mkdir -p "$claude_config_dir"

  # Our MCP servers config (editor + preview)
  local mcp_json='{
  "superdoc": {
    "command": "node",
    "args": ["'"$SUPERDOC_HOME"'/mcp-wrapper.js"],
    "env": {
      "SUPERDOC_HOME": "'"$SUPERDOC_HOME"'"
    }
  },
  "superdoc-preview": {
    "command": "node",
    "args": ["'"$SUPERDOC_HOME"'/mcp-preview/wrapper.js"]
  }
}'

  if [ -f "$claude_config" ]; then
    # Config exists
    if command -v jq &> /dev/null; then
      # Use jq to merge
      local tmp_config=$(mktemp)
      jq --argjson superdoc "$mcp_json" '.mcpServers = (.mcpServers // {}) + $superdoc' "$claude_config" > "$tmp_config"
      mv "$tmp_config" "$claude_config"
      info "Added SuperDoc MCP servers to Claude Desktop config"
    else
      if grep -q '"superdoc"' "$claude_config" && grep -q '"superdoc-preview"' "$claude_config"; then
        info "SuperDoc MCP servers already configured"
      else
        warn "Install jq for auto-config, or manually add to: $claude_config"
      fi
    fi
  else
    # Create new config
    cat > "$claude_config" << EOF
{
  "mcpServers": $mcp_json
}
EOF
    info "Created Claude Desktop MCP config"
  fi
}

# Install skill
install_skill() {
  # Remove old skill locations
  rm -rf "$SKILLS_DIR/superdoc" 2>/dev/null || true
  rm -rf "$SKILLS_DIR/superdoc-edit-docx" 2>/dev/null || true

  mkdir -p "$SKILLS_DIR/superdoc"

  cat > "$SKILLS_DIR/superdoc/skill.md" << 'EOF'
# SuperDoc

Edit and preview Word documents (.docx files).

## Two Ways to Work with Documents

### 1. Direct Editing (MCP Tools)
The `superdoc` MCP server provides tools for programmatic document editing.
Just ask Claude to edit, modify, or update any .docx file.

### 2. Visual Preview (Browser App)
The `superdoc-preview` MCP server opens documents in a browser-based editor.
Ask Claude to "preview" or "open in browser" to use this mode.

## Available Tools

### Preview Tools (superdoc-preview)
- **open_preview** - Open a document in browser for visual editing
- **find_documents** - Search for .docx files by name or pattern
- **stop_preview** - Stop the preview server
- **preview_status** - Check if preview is running

### Editor Tools (superdoc)
- superdoc_open, superdoc_save, superdoc_close
- superdoc_find, superdoc_insert, superdoc_replace, superdoc_delete
- And more for formatting, comments, tracked changes

## Example Requests

| Request | What Happens |
|---------|--------------|
| "Preview my report" | Uses find_documents + open_preview |
| "Edit report.docx and add a title" | Uses superdoc MCP tools directly |
| "Find all docx files in Documents" | Uses find_documents tool |
| "Open sample.docx in browser" | Uses open_preview tool |

## Setup API Key (Optional)

For AI chat features in preview mode:
```bash
echo "ANTHROPIC_API_KEY=sk-ant-..." > ~/superdoc/claude/.env
```
EOF

  info "Installed skill to $SKILLS_DIR/superdoc/"
}

# Print success
print_success() {
  echo ""
  echo -e "${GREEN}========================================${NC}"
  echo -e "${GREEN}  SuperDoc installed successfully!${NC}"
  echo -e "${GREEN}========================================${NC}"
  echo ""
  echo "Installed to: $SUPERDOC_HOME"
  echo ""
  echo "MCP SERVERS INSTALLED:"
  echo "  - superdoc: Direct document editing tools"
  echo "  - superdoc-preview: Browser-based preview with AI chat"
  echo ""
  echo "NEXT STEPS:"
  echo "1. Restart Claude Desktop (Cmd+Q, then reopen)"
  echo "2. Try: 'Preview my document' or 'Find docx files'"
  echo ""
  echo "OPTIONAL - Set API key for preview AI features:"
  echo "  echo 'ANTHROPIC_API_KEY=sk-ant-...' > $SUPERDOC_HOME/.env"
  echo ""
}

# Main
main() {
  # Check for --uninstall flag
  if [ "$1" = "--uninstall" ]; then
    uninstall
  fi

  echo ""
  info "Installing SuperDoc..."
  echo ""

  check_requirements
  setup_dirs
  install_mcp_wrapper
  install_preview_mcp
  install_preview
  install_preview_wrapper
  setup_env
  setup_mcp_config
  install_skill
  print_success
}

main "$@"

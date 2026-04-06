#!/bin/bash
set -e

# SuperDoc Setup Script
# Usage: curl -fsSL https://raw.githubusercontent.com/mattConnHarbour/agentic-collaboration-demo/claude-desktop/superdoc-setup.sh | bash

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

# Download MCP wrapper
install_mcp_wrapper() {
  local url="https://raw.githubusercontent.com/$REPO/$BRANCH/scripts/superdoc-mcp-wrapper.js"
  curl -fsSL "$url" -o "$SUPERDOC_HOME/mcp-wrapper.js"
  chmod +x "$SUPERDOC_HOME/mcp-wrapper.js"
  info "Installed MCP wrapper"
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

  # Our MCP server config
  local mcp_json='{
  "superdoc": {
    "command": "node",
    "args": ["'"$SUPERDOC_HOME"'/mcp-wrapper.js"],
    "env": {
      "SUPERDOC_HOME": "'"$SUPERDOC_HOME"'"
    }
  }
}'

  if [ -f "$claude_config" ]; then
    # Config exists
    if command -v jq &> /dev/null; then
      # Use jq to merge
      local tmp_config=$(mktemp)
      jq --argjson superdoc "$mcp_json" '.mcpServers = (.mcpServers // {}) + $superdoc' "$claude_config" > "$tmp_config"
      mv "$tmp_config" "$claude_config"
      info "Added SuperDoc to Claude Desktop MCP config"
    else
      if grep -q '"superdoc"' "$claude_config"; then
        info "SuperDoc MCP already configured"
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

## Document Editing

MCP tools are available automatically for editing documents.
Just ask Claude to edit, modify, or update any .docx file.

## Preview Documents

To open a document for visual preview in browser:

```bash
node ~/superdoc/claude/preview/dist/server.js /absolute/path/to/document.docx
```

The preview opens in your browser with:
- Live document view
- AI chat assistant (if API key configured)
- Auto-save

## Setup API Key

For AI features in preview mode, tell Claude:
"Set my SuperDoc API key to sk-ant-..."

Or manually:
```bash
echo "ANTHROPIC_API_KEY=sk-ant-..." > ~/superdoc/claude/.env
```

## Quick Reference

| Request | Action |
|---------|--------|
| "Edit report.docx" | MCP tools (automatic) |
| "Preview report.docx" | `node ~/superdoc/claude/preview/dist/server.js /path/to/report.docx` |
| "Set API key to sk-ant-..." | Write to ~/superdoc/claude/.env |
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
  echo "NEXT STEPS:"
  echo "1. Restart Claude Desktop (Cmd+Q, then reopen)"
  echo "2. Claude now has document editing tools"
  echo ""
  echo "OPTIONAL - Set API key for preview AI features:"
  echo "  Tell Claude: 'Set my SuperDoc API key to sk-ant-...'"
  echo ""
}

# Main
main() {
  echo ""
  info "Installing SuperDoc..."
  echo ""

  check_requirements
  setup_dirs
  install_mcp_wrapper
  install_preview
  setup_env
  setup_mcp_config
  install_skill
  print_success
}

main "$@"

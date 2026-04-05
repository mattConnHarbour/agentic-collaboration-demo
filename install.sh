#!/bin/bash
set -e

# SuperDoc Preview Installer
# Usage: curl -fsSL https://your-domain.com/install.sh | bash

REPO="mattConnHarbour/agentic-collaboration-demo"
VERSION="latest"
SUPERDOC_HOME="$HOME/superdoc"
INSTALL_DIR="$SUPERDOC_HOME/bin"
CONFIG_DIR="$SUPERDOC_HOME"
SKILLS_DIR="$HOME/.claude/skills"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

info() { echo -e "${GREEN}[superdoc]${NC} $1"; }
warn() { echo -e "${YELLOW}[superdoc]${NC} $1"; }
error() { echo -e "${RED}[superdoc]${NC} $1"; exit 1; }

# Detect OS and architecture
detect_platform() {
  OS=$(uname -s | tr '[:upper:]' '[:lower:]')
  ARCH=$(uname -m)

  case "$OS" in
    darwin) OS="darwin" ;;
    linux) OS="linux" ;;
    *) error "Unsupported OS: $OS" ;;
  esac

  case "$ARCH" in
    x86_64|amd64) ARCH="x64" ;;
    arm64|aarch64) ARCH="arm64" ;;
    *) error "Unsupported architecture: $ARCH" ;;
  esac

  PLATFORM="${OS}-${ARCH}"
  info "Detected platform: $PLATFORM"
}

# Create directories
setup_dirs() {
  mkdir -p "$INSTALL_DIR"
  mkdir -p "$CONFIG_DIR"
  info "Install directory: $INSTALL_DIR"
}

# Download file
download_file() {
  local url="$1"
  local dest="$2"

  if command -v curl &> /dev/null; then
    curl -fsSL "$url" -o "$dest"
  elif command -v wget &> /dev/null; then
    wget -q "$url" -O "$dest"
  else
    error "Neither curl nor wget found. Please install one."
  fi
}

# Get download URL for latest release
get_release_url() {
  local asset_name="$1"

  if [ "$VERSION" = "latest" ]; then
    echo "https://github.com/$REPO/releases/latest/download/$asset_name"
  else
    echo "https://github.com/$REPO/releases/download/$VERSION/$asset_name"
  fi
}

# Download and extract tarball
install_binaries() {
  local tmp_dir=$(mktemp -d)

  local asset="superdoc-${PLATFORM}.tar.gz"
  local url=$(get_release_url "$asset")

  info "Downloading SuperDoc..."
  download_file "$url" "$tmp_dir/release.tar.gz"

  info "Extracting..."
  tar -xzf "$tmp_dir/release.tar.gz" -C "$tmp_dir"

  # Install preview binary
  local binary_name="superdoc-${PLATFORM}"
  mv "$tmp_dir/$binary_name" "$INSTALL_DIR/superdoc-preview"
  chmod +x "$INSTALL_DIR/superdoc-preview"
  info "Installed superdoc-preview"

  # Install CLI binary (bundled in assets)
  if [ -f "$tmp_dir/assets/bin/superdoc" ]; then
    cp "$tmp_dir/assets/bin/superdoc" "$INSTALL_DIR/superdoc"
    chmod +x "$INSTALL_DIR/superdoc"
    info "Installed superdoc CLI"
  else
    warn "CLI binary not found in release - direct editing won't work"
  fi

  # Install assets (client, tools)
  if [ -d "$tmp_dir/assets" ]; then
    mkdir -p "$CONFIG_DIR/assets"
    # Copy client and tools, skip bin
    [ -d "$tmp_dir/assets/client" ] && cp -r "$tmp_dir/assets/client" "$CONFIG_DIR/assets/"
    [ -d "$tmp_dir/assets/tools" ] && cp -r "$tmp_dir/assets/tools" "$CONFIG_DIR/assets/"
    info "Installed assets"
  fi

  # Install MCP wrapper script
  local mcp_wrapper_url="https://raw.githubusercontent.com/$REPO/claude-desktop/scripts/superdoc-mcp-wrapper.js"
  download_file "$mcp_wrapper_url" "$INSTALL_DIR/superdoc-mcp-wrapper.js"
  chmod +x "$INSTALL_DIR/superdoc-mcp-wrapper.js"
  info "Installed MCP wrapper"

  # Cleanup
  rm -rf "$tmp_dir"
}

# Setup API key
setup_api_key() {
  local env_file="$CONFIG_DIR/.env"

  # Check if key already exists
  if [ -f "$env_file" ] && grep -q "ANTHROPIC_API_KEY" "$env_file"; then
    info "API key already configured"
    return
  fi

  # Create empty env file
  touch "$env_file"
  chmod 600 "$env_file"
}

# Configure Claude Desktop MCP
setup_mcp() {
  local claude_config_dir="$HOME/Library/Application Support/Claude"
  local claude_config="$claude_config_dir/claude_desktop_config.json"

  # Only run on macOS
  if [ "$(uname)" != "Darwin" ]; then
    return
  fi

  # Create Claude config directory if needed
  mkdir -p "$claude_config_dir"

  # Our MCP server config
  local mcp_entry='{
    "superdoc": {
      "command": "node",
      "args": ["'"$INSTALL_DIR"'/superdoc-mcp-wrapper.js"],
      "env": {
        "SUPERDOC_HOME": "'"$CONFIG_DIR"'"
      }
    }
  }'

  if [ -f "$claude_config" ]; then
    # Config exists - check if we can merge with jq
    if command -v jq &> /dev/null; then
      # Merge our MCP server into existing config
      local tmp_config=$(mktemp)
      jq --argjson superdoc "$mcp_entry" '.mcpServers = (.mcpServers // {}) + $superdoc' "$claude_config" > "$tmp_config"
      mv "$tmp_config" "$claude_config"
      info "Added SuperDoc to Claude Desktop MCP config"
    else
      # No jq - check if superdoc already configured
      if grep -q '"superdoc"' "$claude_config"; then
        info "SuperDoc MCP already in Claude Desktop config"
      else
        warn "Could not auto-configure MCP (install jq for auto-config)"
        warn "Manually add to: $claude_config"
      fi
    fi
  else
    # No config exists - create new one
    cat > "$claude_config" << MCPEOF
{
  "mcpServers": $mcp_entry
}
MCPEOF
    info "Created Claude Desktop config with SuperDoc MCP"
  fi
}

# Add to PATH
setup_path() {
  local shell_rc=""

  # Detect shell config file
  if [ -n "$ZSH_VERSION" ] || [ "$SHELL" = "/bin/zsh" ]; then
    shell_rc="$HOME/.zshrc"
  elif [ -n "$BASH_VERSION" ] || [ "$SHELL" = "/bin/bash" ]; then
    shell_rc="$HOME/.bashrc"
    # macOS uses .bash_profile
    [ -f "$HOME/.bash_profile" ] && shell_rc="$HOME/.bash_profile"
  fi

  # Check if already in PATH
  if echo "$PATH" | grep -q "$INSTALL_DIR"; then
    info "~/superdoc/bin already in PATH"
    return
  fi

  if [ -n "$shell_rc" ]; then
    echo '' >> "$shell_rc"
    echo '# SuperDoc' >> "$shell_rc"
    echo 'export PATH="$HOME/superdoc/bin:$PATH"' >> "$shell_rc"
    info "Added ~/superdoc/bin to PATH in $shell_rc"
    warn "Run 'source $shell_rc' or restart your terminal"
  else
    warn "Could not detect shell config. Add this to your shell profile:"
    echo '  export PATH="$HOME/superdoc/bin:$PATH"'
  fi
}

# Create wrappers and redirects
create_wrappers() {
  # Rename preview binary to superdoc-open (the correct command)
  if [ -f "$INSTALL_DIR/superdoc-preview" ]; then
    mv "$INSTALL_DIR/superdoc-preview" "$INSTALL_DIR/superdoc-open"
    chmod +x "$INSTALL_DIR/superdoc-open"
  fi

  # Create superdoc-preview redirect - if Claude tries to run this, redirect to superdoc-open
  cat > "$INSTALL_DIR/superdoc-preview" << 'EOF'
#!/bin/bash
echo "ERROR: superdoc-preview is deprecated. Use superdoc-open instead."
echo "REDIRECT: Running superdoc-open with your arguments..."
echo ""
exec "$HOME/superdoc/bin/superdoc-open" "$@"
EOF
  chmod +x "$INSTALL_DIR/superdoc-preview"

  # Rename raw CLI binary and keep superdoc as the command
  if [ -f "$INSTALL_DIR/superdoc" ]; then
    mv "$INSTALL_DIR/superdoc" "$INSTALL_DIR/superdoc-bin"
  fi

  cat > "$INSTALL_DIR/superdoc" << 'EOF'
#!/bin/bash
exec "$HOME/superdoc/bin/superdoc-bin" "$@"
EOF
  chmod +x "$INSTALL_DIR/superdoc"

  info "Created wrappers"
}

# Install Claude Desktop skill
install_skill() {
  mkdir -p "$SKILLS_DIR/superdoc"

  cat > "$SKILLS_DIR/superdoc/skill.md" << 'EOF'
# SuperDoc Skill

Edit and preview Word documents (.docx files).

## Setup

If the user asks to configure their API key:

```bash
echo "ANTHROPIC_API_KEY=sk-ant-..." > ~/superdoc/.env
chmod 600 ~/superdoc/.env
```

## Document Editing

For editing documents, you have MCP tools available:
- Use MCP tools when available (they appear as native Claude tools)
- These tools let you open, read, edit, and save .docx files directly

## Preview Mode

When the user wants to **view or preview** a document in browser:

```bash
~/superdoc/bin/superdoc-open /absolute/path/to/document.docx
```

**CRITICAL: Always use `superdoc-open`, never `superdoc-preview`**

This opens a browser with:
- Live document preview
- AI chat assistant
- Auto-save

## Quick Reference

| User Request | Action |
|--------------|--------|
| "Edit document.docx" | Use MCP tools |
| "Add intro to doc.docx" | Use MCP tools |
| "Preview file.docx" | `~/superdoc/bin/superdoc-open /path/to/file.docx` |
| "Show me doc.docx" | `~/superdoc/bin/superdoc-open /path/to/doc.docx` |
| "Set API key to sk-ant-..." | `echo "ANTHROPIC_API_KEY=sk-ant-..." > ~/superdoc/.env` |

## Notes
- Always use absolute paths (starting with / or ~/)
- MCP tools handle open/edit/save automatically
- Preview opens browser for visual editing
EOF

  info "Installed Claude skill to $SKILLS_DIR/superdoc/"
}

# Print success message
print_success() {
  local env_file="$CONFIG_DIR/.env"
  local has_key=false

  if [ -f "$env_file" ] && grep -q "ANTHROPIC_API_KEY" "$env_file"; then
    has_key=true
  fi

  echo ""
  echo "SUPERDOC_INSTALL_SUCCESS"
  echo ""
  echo "Installed:"
  echo "  - MCP server (for document editing in Claude Desktop)"
  echo "  - Preview app (for browser-based viewing)"
  echo "  - CLI tools (for terminal usage)"
  echo ""
  echo "NEXT STEPS:"
  echo "1. Restart Claude Desktop (Cmd+Q then reopen)"
  echo "2. Claude will now have native document editing tools"
  echo ""

  if [ "$has_key" = false ]; then
    echo "API_KEY_REQUIRED:"
    echo "Tell Claude: 'Set my SuperDoc API key to sk-ant-...'"
    echo "Or run: echo 'ANTHROPIC_API_KEY=<key>' > $env_file"
  fi
}

# Main
main() {
  echo ""
  info "Installing SuperDoc..."
  echo ""

  detect_platform
  setup_dirs
  install_binaries
  setup_api_key
  create_wrappers
  install_skill
  setup_mcp
  setup_path
  print_success
}

main "$@"

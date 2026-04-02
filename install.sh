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

  local asset="superdoc-preview-${PLATFORM}.tar.gz"
  local url=$(get_release_url "$asset")

  info "Downloading SuperDoc..."
  download_file "$url" "$tmp_dir/release.tar.gz"

  info "Extracting..."
  tar -xzf "$tmp_dir/release.tar.gz" -C "$tmp_dir"

  # Install preview binary
  local binary_name="superdoc-preview-${PLATFORM}"
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

  # Cleanup
  rm -rf "$tmp_dir"
}

# Setup API key
setup_api_key() {
  local env_file="$CONFIG_DIR/.env"

  # Check if key already exists
  if [ -f "$env_file" ] && grep -q "ANTHROPIC_API_KEY" "$env_file"; then
    warn "API key already configured in $env_file"
    return
  fi

  # Check if running interactively (has a TTY)
  if [ ! -t 0 ]; then
    warn "Non-interactive mode: skipping API key setup"
    warn "Set ANTHROPIC_API_KEY later in $env_file"
    return
  fi

  echo ""
  info "Anthropic API key required for AI features."
  info "Get one at: https://console.anthropic.com/settings/keys"
  echo ""

  read -p "Enter your Anthropic API key (or press Enter to skip): " api_key

  if [ -n "$api_key" ]; then
    echo "ANTHROPIC_API_KEY=$api_key" >> "$env_file"
    chmod 600 "$env_file"
    info "API key saved to $env_file"
  else
    warn "Skipped API key setup. Set ANTHROPIC_API_KEY later in $env_file"
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

# Create wrapper scripts
create_wrappers() {
  # Wrapper for preview app
  cat > "$INSTALL_DIR/superdoc-open" << 'EOF'
#!/bin/bash
# Load config
if [ -f "$HOME/superdoc/.env" ]; then
  export $(grep -v '^#' "$HOME/superdoc/.env" | xargs)
fi

# Set paths for installed mode
export SUPERDOC_CLI_BIN="$HOME/superdoc/bin/superdoc-bin"
export SUPERDOC_CLIENT_DIR="$HOME/superdoc/assets/client"
export SUPERDOC_TOOLS_DIR="$HOME/superdoc/assets/tools"

exec "$HOME/superdoc/bin/superdoc-preview" "$@"
EOF
  chmod +x "$INSTALL_DIR/superdoc-open"

  # Rename raw CLI binary and create wrapper
  if [ -f "$INSTALL_DIR/superdoc" ]; then
    mv "$INSTALL_DIR/superdoc" "$INSTALL_DIR/superdoc-bin"
  fi

  cat > "$INSTALL_DIR/superdoc" << 'EOF'
#!/bin/bash
# Load config for CLI
if [ -f "$HOME/superdoc/.env" ]; then
  export $(grep -v '^#' "$HOME/superdoc/.env" | xargs)
fi

exec "$HOME/superdoc/bin/superdoc-bin" "$@"
EOF
  chmod +x "$INSTALL_DIR/superdoc"

  info "Created wrapper scripts"
}

# Install Claude Desktop skill
install_skill() {
  mkdir -p "$SKILLS_DIR/superdoc"

  cat > "$SKILLS_DIR/superdoc/skill.md" << 'EOF'
# SuperDoc Skill

Use this skill to edit or preview Word documents (.docx files).

## Two Modes

### 1. Direct Edit Mode (use superdoc CLI)
When the user asks you to **edit, modify, or change** a document directly.

Examples:
- "Add an introduction to report.docx"
- "Fix the typos in my-doc.docx"
- "Make the title bold in document.docx"

Use the `superdoc` CLI tool:
```bash
superdoc doc open /path/to/document.docx
superdoc doc get --action text
superdoc doc insert --value "New content here" --block-id "00000001" --offset 0
superdoc doc save
superdoc doc close
```

Key commands:
- `superdoc doc open <file>` - Open document for editing
- `superdoc doc get --action text` - Get document text content
- `superdoc doc get --action blocks` - Get document structure with block IDs
- `superdoc doc insert --value "text" --block-id "ID" --offset N` - Insert text
- `superdoc doc create --action paragraph --text "content"` - Create new paragraph
- `superdoc doc save` - Save changes
- `superdoc doc close` - Close document

Run `superdoc doc --help` for full command reference.

### 2. Preview Mode (use superdoc-open)
When the user wants to **preview, view, or collaboratively edit** with the browser UI.

Examples:
- "Open report.docx for preview"
- "Let me see my-doc.docx"
- "Open document.docx so I can edit it interactively"

```bash
superdoc-open /path/to/document.docx
```

This opens a browser with:
- Live document preview
- AI chat assistant for interactive editing
- Auto-save every 2 seconds

## Choosing the Right Mode

| User Request | Mode | Command |
|--------------|------|---------|
| "Add X to document.docx" | Direct Edit | `superdoc doc open ...` |
| "Change the title in doc.docx" | Direct Edit | `superdoc doc open ...` |
| "Preview my-file.docx" | Preview | `superdoc-open ...` |
| "Open doc.docx for editing" | Preview | `superdoc-open ...` |
| "Show me document.docx" | Preview | `superdoc-open ...` |

## Notes
- Always use absolute paths for documents
- For direct edits, remember to `save` and `close` when done
- The document must be a .docx file
EOF

  info "Installed Claude skill to $SKILLS_DIR/superdoc/"
}

# Print success message
print_success() {
  echo ""
  echo -e "${GREEN}============================================${NC}"
  echo -e "${GREEN}  SuperDoc installed successfully!${NC}"
  echo -e "${GREEN}============================================${NC}"
  echo ""
  echo "Installed:"
  echo "  ~/superdoc/bin/superdoc-open  - Open documents with AI editing"
  echo "  ~/superdoc/bin/superdoc       - SuperDoc CLI"
  echo "  ~/superdoc/assets/            - Client and tools"
  echo "  ~/.claude/skills/superdoc/    - Claude Desktop skill"
  echo ""
  echo "Usage in Claude Desktop:"
  echo "  'Edit my-document.docx and add an introduction'"
  echo "  'Open report.docx with superdoc'"
  echo ""
  echo "Manual usage:"
  echo "  superdoc-open document.docx"
  echo ""

  if ! echo "$PATH" | grep -q "$INSTALL_DIR"; then
    warn "Restart your terminal or run:"
    echo "  source ~/.zshrc  # or ~/.bashrc"
  fi
}

# Main
main() {
  echo ""
  info "Installing SuperDoc Preview..."
  echo ""

  detect_platform
  setup_dirs
  install_binaries
  setup_api_key
  create_wrappers
  install_skill
  setup_path
  print_success
}

main "$@"

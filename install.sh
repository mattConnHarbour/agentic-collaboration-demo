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
    info "API key already configured"
    return
  fi

  # Create empty env file
  touch "$env_file"
  chmod 600 "$env_file"
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

Use this skill to edit or preview Word documents (.docx files).

## Setup

If the user asks to set up SuperDoc or configure their API key:

```bash
# Set the Anthropic API key (required for AI features in preview mode)
echo "ANTHROPIC_API_KEY=sk-ant-..." > ~/superdoc/.env
chmod 600 ~/superdoc/.env
```

The wrapper scripts automatically load this file - no `export` needed.

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

### 2. Preview Mode
When the user wants to **preview, view, or collaboratively edit** with the browser UI.

Examples:
- "Open report.docx for preview"
- "Let me see my-doc.docx"
- "Open document.docx so I can edit it interactively"

**CRITICAL: You MUST use this exact command:**

```bash
~/superdoc/bin/superdoc-open /absolute/path/to/document.docx
```

DO NOT use any other binary. DO NOT use superdoc-preview. ONLY use superdoc-open.

This opens a browser with:
- Live document preview
- AI chat assistant for interactive editing
- Auto-save every 2 seconds

## Choosing the Right Mode

| User Request | Mode | Command |
|--------------|------|---------|
| "Add X to document.docx" | Direct Edit | `superdoc doc open ...` |
| "Change the title in doc.docx" | Direct Edit | `superdoc doc open ...` |
| "Preview my-file.docx" | Preview | `~/superdoc/bin/superdoc-open ...` |
| "Open doc.docx for editing" | Preview | `~/superdoc/bin/superdoc-open ...` |
| "Show me document.docx" | Preview | `~/superdoc/bin/superdoc-open ...` |

## Notes
- Always use absolute paths for documents
- For direct edits, remember to `save` and `close` when done
- The document must be a .docx file

## Troubleshooting

If commands fail with "command not found":
```bash
# Check if installed
ls ~/superdoc/bin/

# Add to PATH for current session
export PATH="$HOME/superdoc/bin:$PATH"

# Or reinstall
curl -fsSL https://raw.githubusercontent.com/mattConnHarbour/agentic-collaboration-demo/claude-desktop/install.sh | bash
```

If preview mode shows API errors, set the API key (see Setup section above).

## IMPORTANT REMINDERS

- For preview: ONLY use `~/superdoc/bin/superdoc-open` - never use superdoc-preview
- For direct edits: Use `superdoc doc open/get/insert/save/close` commands
- Always use absolute paths (starting with / or ~)
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
  echo "binaries=$INSTALL_DIR"
  echo "assets=$CONFIG_DIR/assets"
  echo "skill=$SKILLS_DIR/superdoc"
  echo "env_file=$env_file"
  echo "api_key_configured=$has_key"
  echo ""

  if [ "$has_key" = false ]; then
    echo "ACTION_REQUIRED: Ask user for Anthropic API key, then run:"
    echo "echo 'ANTHROPIC_API_KEY=<key>' > $env_file && chmod 600 $env_file"
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

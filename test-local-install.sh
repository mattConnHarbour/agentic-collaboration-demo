#!/bin/bash
set -e

# Local Test Install Script
# Simulates the curl install using local files (no GitHub needed)

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
SUPERDOC_HOME="$HOME/superdoc/claude"
SKILLS_DIR="$HOME/.claude/skills"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info() { echo -e "${GREEN}[test]${NC} $1"; }
warn() { echo -e "${YELLOW}[test]${NC} $1"; }
error() { echo -e "${RED}[test]${NC} $1"; exit 1; }

# Step 1: Uninstall existing
info "Step 1: Cleaning up existing installation..."
bash "$REPO_DIR/superdoc-uninstall.sh" 2>/dev/null || true
echo ""

# Step 2: Create directories
info "Step 2: Creating directories..."
mkdir -p "$SUPERDOC_HOME"
mkdir -p "$SUPERDOC_HOME/preview"
mkdir -p "$SKILLS_DIR/superdoc"

# Step 3: Copy MCP wrapper
info "Step 3: Installing MCP wrapper..."
cp "$REPO_DIR/scripts/superdoc-mcp-wrapper.js" "$SUPERDOC_HOME/mcp-wrapper.js"
chmod +x "$SUPERDOC_HOME/mcp-wrapper.js"

# Step 4: Copy and build preview server
info "Step 4: Installing preview server..."
cp -r "$REPO_DIR/server/"* "$SUPERDOC_HOME/preview/"

info "Step 5: Installing dependencies (this may take a moment)..."
cd "$SUPERDOC_HOME/preview" && npm install --silent

info "Step 6: Building server..."
cd "$SUPERDOC_HOME/preview" && npm run build:ts

# Step 7: Create empty .env
info "Step 7: Creating .env file..."
if [ ! -f "$SUPERDOC_HOME/.env" ]; then
  touch "$SUPERDOC_HOME/.env"
  chmod 600 "$SUPERDOC_HOME/.env"
  warn "No API key set. Add: echo 'ANTHROPIC_API_KEY=sk-ant-...' > $SUPERDOC_HOME/.env"
fi

# Step 8: Install skill
info "Step 8: Installing skill..."
cp "$REPO_DIR/skill/superdoc-edit-docx.md" "$SKILLS_DIR/superdoc/skill.md"

# Step 9: Configure Claude Desktop MCP
info "Step 9: Configuring Claude Desktop MCP..."
CLAUDE_CONFIG_DIR="$HOME/Library/Application Support/Claude"
CLAUDE_CONFIG="$CLAUDE_CONFIG_DIR/claude_desktop_config.json"

mkdir -p "$CLAUDE_CONFIG_DIR"

MCP_JSON='{
  "superdoc": {
    "command": "node",
    "args": ["'"$SUPERDOC_HOME"'/mcp-wrapper.js"],
    "env": {
      "SUPERDOC_HOME": "'"$SUPERDOC_HOME"'"
    }
  }
}'

if [ -f "$CLAUDE_CONFIG" ]; then
  if command -v jq &> /dev/null; then
    tmp_config=$(mktemp)
    jq --argjson superdoc "$MCP_JSON" '.mcpServers = (.mcpServers // {}) + $superdoc' "$CLAUDE_CONFIG" > "$tmp_config"
    mv "$tmp_config" "$CLAUDE_CONFIG"
    info "Added SuperDoc to existing Claude Desktop config"
  else
    if grep -q '"superdoc"' "$CLAUDE_CONFIG"; then
      info "SuperDoc MCP already configured"
    else
      warn "Install jq for auto-config, or manually add to: $CLAUDE_CONFIG"
    fi
  fi
else
  cat > "$CLAUDE_CONFIG" << EOF
{
  "mcpServers": $MCP_JSON
}
EOF
  info "Created Claude Desktop config"
fi

# Done
echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}  Local test install complete!${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo "Installed to: $SUPERDOC_HOME"
echo ""
echo "NEXT STEPS:"
echo "1. Restart Claude Desktop (Cmd+Q, then reopen)"
echo "2. Test MCP: Ask Claude 'What document tools do you have?'"
echo "3. Test preview: Ask Claude 'Preview ~/Desktop/test.docx'"
echo ""
if [ ! -s "$SUPERDOC_HOME/.env" ]; then
  echo -e "${YELLOW}API KEY NEEDED for AI chat in preview:${NC}"
  echo "  echo 'ANTHROPIC_API_KEY=sk-ant-...' > $SUPERDOC_HOME/.env"
  echo ""
fi

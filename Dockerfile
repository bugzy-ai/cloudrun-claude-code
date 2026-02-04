# ---- build stage ----
FROM node:20-bookworm AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- runtime stage ----
# Use slim base image - all required system deps are installed explicitly via apt-get below
FROM node:20-bookworm-slim
WORKDIR /app

# Copy package version manifest (single source of truth for third-party versions)
COPY .package-versions.env /tmp/.package-versions.env

# Install system dependencies needed for Claude Code SDK and Playwright/Chromium
# Enable backports to get OpenSSH 10.0 (supports Ed25519 PKCS#8 format keys)
RUN echo 'deb http://deb.debian.org/debian bookworm-backports main' > /etc/apt/sources.list.d/backports.list && \
  apt-get update && apt-get install -y --no-install-recommends \
  bash git ripgrep ca-certificates curl \
  openssh-client/bookworm-backports \
  # Chromium system dependencies for Playwright
  libasound2 \
  libatk-bridge2.0-0 \
  libatk1.0-0 \
  libatspi2.0-0 \
  libcairo2 \
  libcups2 \
  libdbus-1-3 \
  libdrm2 \
  libgbm1 \
  libglib2.0-0 \
  libnspr4 \
  libnss3 \
  libpango-1.0-0 \
  libwayland-client0 \
  libx11-6 \
  libxcb1 \
  libxcomposite1 \
  libxdamage1 \
  libxext6 \
  libxfixes3 \
  libxkbcommon0 \
  libxrandr2 \
  && rm -rf /var/lib/apt/lists/*

# Set browser path to shared location accessible by all users
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright

# Disable Claude Code auto-updater (container images should be immutable)
ENV DISABLE_AUTOUPDATER=1

# Install Claude Code natively (self-contained binary, no Node.js dependency)
# The installer places the binary at ~/.local/bin/claude -> ~/.local/share/claude/versions/<ver>
# Copy the resolved binary to /usr/local/bin so it's accessible to all users
RUN curl -fsSL https://claude.ai/install.sh | bash \
  && cp "$(readlink -f /root/.local/bin/claude)" /usr/local/bin/claude

# Install global npm packages — third-party pinned from .package-versions.env, our packages unpinned
RUN . /tmp/.package-versions.env && \
  npm install -g \
  playwright@${PLAYWRIGHT_VERSION} \
  @playwright/mcp@${PLAYWRIGHT_MCP_VERSION} \
  @notionhq/notion-mcp-server@${NOTION_MCP_VERSION} \
  simple-slack-mcp-server \
  @mcp-tunnel/wrapper \
  @bugzy-ai/jira-mcp-server \
  @bugzy-ai/jira-cloud-mcp-server \
  @bugzy-ai/teams-mcp-server \
  @bugzy-ai/resend-mcp-server \
  @bugzy-ai/github-mcp-server \
  @bugzy-ai/azure-devops-mcp-server \
  && npm cache clean --force

# Install Playwright browsers for both consumers:
# 1. Global playwright (used by project's @playwright/test) — chromium + ffmpeg
# 2. @playwright/mcp's bundled playwright — chromium only (different revision)
RUN playwright install chromium && playwright install ffmpeg && \
  /usr/local/lib/node_modules/@playwright/mcp/node_modules/.bin/playwright install chromium

# Set up environment
ENV NODE_PATH=/usr/local/lib/node_modules
ENV PATH="/usr/local/lib/node_modules/.bin:${PATH}"

# Copy built application
COPY --from=build /app/dist ./dist
COPY package*.json ./

# Install production dependencies (without claude-code since it's global now)
RUN npm ci --omit=dev

# No default MCP or system prompt paths - all configuration is dynamic

# Create two users for security isolation:
# 1. serveruser: Owns server code (read-only for others)
# 2. claudeuser: Runs both server and Claude processes
RUN useradd -m -u 1001 -s /bin/bash serveruser && \
  useradd -m -u 1002 -s /bin/bash claudeuser && \
  # SECURITY: Server code owned by serveruser, readable by all (755)
  # This allows claudeuser to read and execute, but not modify
  chown -R serveruser:serveruser /app && \
  chmod -R 755 /app && \
  # Create workspace base directory for Claude (owned by claudeuser)
  mkdir -p /tmp/workspaces && \
  chown -R claudeuser:claudeuser /tmp/workspaces && \
  # Setup SSH directory for claudeuser
  mkdir -p /home/claudeuser/.ssh && \
  chmod 700 /home/claudeuser/.ssh && \
  chown -R claudeuser:claudeuser /home/claudeuser/.ssh && \
  # Make Playwright browsers writable by claudeuser for MCP temp directories
  chown -R claudeuser:claudeuser /opt/ms-playwright

# Configure git for claudeuser and switch to claudeuser for running the server
# Server code in /app is owned by serveruser with 755 permissions
# claudeuser can read and execute, but not modify the code
USER claudeuser
RUN git config --global core.sshCommand "ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null"

EXPOSE 8080
CMD ["node", "dist/server.js"]

# ---- build stage ----
FROM node:20-bookworm AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- runtime stage ----
FROM node:20-bookworm
WORKDIR /app

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

# Install Claude Code globally via npm (always gets latest version)
# This approach matches the GitHub Action implementation and simplifies version management
RUN npm install -g @anthropic-ai/claude-code

# Install Playwright package globally for MCP compatibility
# Set browser path to shared location accessible by all users
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
RUN npm install -g playwright@1.56.1

# Install Playwright browsers and dependencies as root
# This ensures browsers are in shared location and system deps are properly installed
RUN playwright install chromium
RUN playwright install-deps chromium
RUN playwright install ffmpeg

# Install MCP servers globally
# This prevents re-downloading packages at runtime for faster MCP startup
RUN npm install -g @playwright/mcp @notionhq/notion-mcp-server simple-slack-mcp-server @mcp-tunnel/wrapper @bugzy-ai/jira-mcp-server @bugzy-ai/teams-mcp-server @bugzy-ai/resend-mcp-server @bugzy-ai/github-mcp-server

# Set up environment
ENV NODE_ENV=production
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

# Configure git for claudeuser
USER claudeuser
RUN git config --global core.sshCommand "ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null"

# Switch to claudeuser to run the main server
# Server code in /app is owned by serveruser with 750 permissions
# claudeuser can execute but not read the code (relies on node loading it)
# This allows spawning Claude as the same user without uid/gid switching
USER claudeuser

EXPOSE 8080
CMD ["node", "dist/server.js"]
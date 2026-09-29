FROM node:24-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    HOME=/home/long \
    DISPLAY=:99 \
    VIRTUAL_DISPLAY=:99 \
    PORT=8318 \
    HTTP_HOST=0.0.0.0 \
    CDP_HOST=127.0.0.1 \
    WORKFLOW_DATA_DIR=/home/long/work/chatgpt-adapter/data \
    WORKFLOW_DB=/home/long/work/chatgpt-adapter/data/workflow.db \
    WORKFLOW_WORKSPACE=/home/long/work/chatgpt-adapter \
    OPENCLAW_BIN=/usr/local/bin/openclaw \
    TMUX_BIN=/usr/bin/tmux \
    NODE_ENV=production

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       ca-certificates curl gnupg git tmux xvfb xauth x11-utils \
       fonts-liberation fonts-noto-color-emoji dumb-init procps \
    && install -d -m 0755 /etc/apt/keyrings \
    && curl -fsSL https://dl.google.com/linux/linux_signing_key.pub \
       | gpg --dearmor -o /etc/apt/keyrings/google-chrome.gpg \
    && echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/google-chrome.gpg] http://dl.google.com/linux/chrome/deb/ stable main" \
       > /etc/apt/sources.list.d/google-chrome.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends google-chrome-stable \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /home/long/work/chatgpt-adapter

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# OpenClaw is used by the durable orchestration/session integration.
RUN npm install -g openclaw@2026.9.5

COPY . .
RUN mkdir -p /home/long/work/chatgpt-adapter/data \
    /home/long/.config/google-chrome-chatgpt \
    /home/long/.config/google-chrome-chatgpt-2 \
    /home/long/.config/google-chrome-chatgpt-3 \
    /home/long/.config/google-chrome-chatgpt-4 \
    /home/long/.openclaw \
    /tmp/chatgpt-adapter \
    && chmod +x scripts/*.sh docker/entrypoint.sh

EXPOSE 8318

ENTRYPOINT ["/usr/bin/dumb-init", "--", "/home/long/work/chatgpt-adapter/docker/entrypoint.sh"]

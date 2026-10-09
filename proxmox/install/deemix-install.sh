#!/usr/bin/env bash

# Copyright (c) 2021-2026 community-scripts ORG
# Author: MickLesk (CanbiZ)
# License: MIT | https://github.com/community-scripts/DevScripts/raw/main/LICENSE
# Source: https://github.com/Ac1drainn/deemix

source /dev/stdin <<<"$FUNCTIONS_FILE_PATH"
color
verb_ip6
catch_errors
setting_up_container
network_check
update_os

DEEMIX_REPO="Ac1drainn/deemix"
DEEMIX_BRANCH="main"

# utf-8-validate ships no linux-arm64 prebuild and compiles through node-gyp there
msg_info "Installing Dependencies"
$STD apt install -y \
  build-essential \
  python3 \
  curl
msg_ok "Installed Dependencies"

# The fork publishes no releases, so install the branch head and record its commit for updates
msg_info "Downloading ${DEEMIX_REPO}@${DEEMIX_BRANCH}"
LATEST_SHA=$(curl -fsSL -H "Accept: application/vnd.github.sha" "https://api.github.com/repos/${DEEMIX_REPO}/commits/${DEEMIX_BRANCH}")
mkdir -p /opt/deemix
curl -fsSL "https://codeload.github.com/${DEEMIX_REPO}/tar.gz/${LATEST_SHA}" | tar -xz --strip-components=1 -C /opt/deemix
echo "$LATEST_SHA" >~/.deemix
msg_ok "Downloaded ${DEEMIX_REPO}@${LATEST_SHA:0:7}"
NODE_VERSION="24" NODE_MODULE="pnpm@$(sed -n 's/.*"packageManager": "pnpm@\([^"+]*\).*/\1/p' /opt/deemix/package.json)" setup_nodejs

# The workspace also holds the Electron desktop app, whose binary the server never uses
msg_info "Building Deemix"
cd /opt/deemix
ELECTRON_SKIP_BINARY_DOWNLOAD=1 $STD pnpm install --frozen-lockfile
$STD pnpm turbo build --filter=deemix-webui...
msg_ok "Built Deemix"

msg_info "Creating Service"
mkdir -p /opt/deemix_data/{config,music}
cat <<EOF >/etc/systemd/system/deemix.service
[Unit]
Description=Deemix
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/deemix
Environment=NODE_ENV=production
Environment=DEEMIX_DATA_DIR=/opt/deemix_data/config
Environment=DEEMIX_MUSIC_DIR=/opt/deemix_data/music
Environment=DEEMIX_SERVER_PORT=6595
Environment=DEEMIX_HOST=0.0.0.0
Environment=DEEMIX_SINGLE_USER=true
ExecStart=/usr/bin/node /opt/deemix/packages/webui/dist/main.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
systemctl enable -q --now deemix
msg_ok "Created Service"

motd_ssh
customize
cleanup_lxc

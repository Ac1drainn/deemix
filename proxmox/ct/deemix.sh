#!/usr/bin/env bash
# Scripts (ct/, install/) are served from this fork; the engine still comes from community-scripts/core
_CS_DEFAULT_URL="https://raw.githubusercontent.com/Ac1drainn/deemix/main/proxmox"
_cs_boot="${COMMUNITY_SCRIPTS_CORE_DIR:-$(dirname "${BASH_SOURCE[0]}")/../../core}/core/build.func"
source "$_cs_boot" 2>/dev/null || source <(curl -fsSL "${COMMUNITY_SCRIPTS_CORE_URL:-https://raw.githubusercontent.com/community-scripts/core/main}/core/build.func")
# Copyright (c) 2021-2026 community-scripts ORG
# Author: MickLesk (CanbiZ)
# License: MIT | https://github.com/community-scripts/DevScripts/raw/main/LICENSE
# Source: https://github.com/Ac1drainn/deemix

APP="Deemix"
var_tags="${var_tags:-music;downloader}"
var_cpu="${var_cpu:-2}"
var_ram="${var_ram:-2048}"
var_disk="${var_disk:-10}"
var_os="${var_os:-debian}"
var_version="${var_version:-13}"
var_arm64="${var_arm64:-yes}"
var_unprivileged="${var_unprivileged:-1}"

# The fork publishes no releases, so installs and updates track a branch head
DEEMIX_REPO="${DEEMIX_REPO:-Ac1drainn/deemix}"
DEEMIX_BRANCH="${DEEMIX_BRANCH:-main}"

header_info "$APP"
variables
color
catch_errors

function update_script() {
  header_info
  check_container_storage
  check_container_resources

  if [[ ! -d /opt/deemix ]]; then
    msg_error "No ${APP} Installation Found!"
    exit
  fi

  LATEST_SHA=$(curl -fsSL -H "Accept: application/vnd.github.sha" "https://api.github.com/repos/${DEEMIX_REPO}/commits/${DEEMIX_BRANCH}")
  if [[ -z "$LATEST_SHA" ]]; then
    msg_error "Could not resolve the latest commit of ${DEEMIX_REPO}@${DEEMIX_BRANCH}"
    exit
  fi
  if [[ "$LATEST_SHA" == "$(cat ~/.deemix 2>/dev/null)" ]]; then
    msg_ok "No update required. ${APP} is already at ${LATEST_SHA:0:7}"
    exit
  fi

  msg_info "Stopping Deemix"
  systemctl stop deemix
  msg_ok "Stopped Deemix"

  # Settings and music live in /opt/deemix_data, so the source tree can be replaced wholesale
  msg_info "Downloading ${DEEMIX_REPO}@${LATEST_SHA:0:7}"
  rm -rf /opt/deemix
  mkdir -p /opt/deemix
  curl -fsSL "https://codeload.github.com/${DEEMIX_REPO}/tar.gz/${LATEST_SHA}" | tar -xz --strip-components=1 -C /opt/deemix
  msg_ok "Downloaded ${DEEMIX_REPO}@${LATEST_SHA:0:7}"
  NODE_VERSION="24" NODE_MODULE="pnpm@$(sed -n 's/.*"packageManager": "pnpm@\([^"+]*\).*/\1/p' /opt/deemix/package.json)" setup_nodejs

  msg_info "Building Deemix"
  cd /opt/deemix
  ELECTRON_SKIP_BINARY_DOWNLOAD=1 $STD pnpm install --frozen-lockfile
  $STD pnpm turbo build --filter=deemix-webui...
  echo "$LATEST_SHA" >~/.deemix
  msg_ok "Built Deemix"

  msg_info "Starting Deemix"
  systemctl start deemix
  msg_ok "Started Deemix"
  msg_ok "Updated successfully!"
  exit
}

start
build_container
description

msg_ok "Completed Successfully!\n"
echo -e "${CREATING}${GN}${APP} setup has been successfully initialized!${CL}"
echo -e "${INFO}${YW}Access it using the following URL:${CL}"
echo -e "${GATEWAY}${BGN}http://${IP}:6595${CL}"

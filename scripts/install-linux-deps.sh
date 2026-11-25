#!/usr/bin/env sh
# The system packages Tauri needs to build on Debian and Ubuntu. CI and the
# release workflow both call this, so the list lives in one place.
set -eu
sudo apt-get update
sudo apt-get install -y \
  libwebkit2gtk-4.1-dev \
  build-essential \
  curl \
  wget \
  file \
  libxdo-dev \
  libssl-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev

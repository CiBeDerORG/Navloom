#!/usr/bin/env sh
set -eu

cd "$(dirname "$0")/.."
mkdir -p bin

for arch in amd64 arm64; do
  echo "Building Navloom Agent for linux/$arch"
  CGO_ENABLED=0 GOOS=linux GOARCH="$arch" go build -trimpath -ldflags="-s -w" -o "bin/navloom-agent-linux-$arch" ./cmd/navloom-agent
done

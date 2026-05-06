#!/usr/bin/env bash

if [ "${CONFIG_ONLY}" != "True" ]; then
  bun install --frozen-lockfile
  # Was 8192, but we want to run this on an 8 GB machine:
  export NODE_OPTIONS=--max_old_space_size=6144
  bun run build
else
  mkdir -p build/config/
fi
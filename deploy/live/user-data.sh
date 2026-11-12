#!/bin/bash
# First boot of the Tessera Live host (Amazon Linux 2023, arm64): Docker, the config, and up.sh. The launch command
# substitutes __IMAGE__, __HOST__ and __UP_SH__ (base64 of up.sh).
set -euo pipefail
dnf install -y docker
systemctl enable --now docker
mkdir -p /opt/tessera
printf 'IMAGE=%s\nHOST=%s\n' "__IMAGE__" "__HOST__" > /opt/tessera/config
echo "__UP_SH__" | base64 -d > /opt/tessera/up.sh
chmod 700 /opt/tessera/up.sh
/opt/tessera/up.sh

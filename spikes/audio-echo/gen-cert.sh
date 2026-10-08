#!/bin/sh
# Self-signed cert for LAN testing (getUserMedia needs HTTPS off localhost).
mkdir -p .cert
openssl req -x509 -newkey rsa:2048 -nodes -days 30 -subj "/CN=zoom3d-spike" \
  -keyout .cert/key.pem -out .cert/cert.pem

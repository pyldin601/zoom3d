#!/bin/sh
# Smoke-tests a built image: scripts/smoke-image.sh server|web <image>
set -eu
service="$1"
image="$2"
name="zoom3d-smoke-$service-$$"
cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT

wait_for() { # url
  i=0
  until curl -fsS "$1" >/dev/null 2>&1; do
    i=$((i + 1))
    if [ "$i" -ge 30 ]; then echo "timed out waiting for $1" >&2; docker logs "$name" >&2; exit 1; fi
    sleep 1
  done
}

expect() { # description, command...
  desc="$1"; shift
  if "$@"; then echo "ok   $desc"; else echo "FAIL $desc" >&2; docker logs "$name" >&2; exit 1; fi
}

case "$service" in
  server)
    docker run -d --name "$name" -p 18787:8787 "$image" >/dev/null
    wait_for http://127.0.0.1:18787/health
    expect "GET /health returns ok" sh -c 'test "$(curl -fsS http://127.0.0.1:18787/health)" = ok'
    expect "unknown path is 404" sh -c 'test "$(curl -s -o /dev/null -w %{http_code} http://127.0.0.1:18787/nope)" = 404'
    expect "runs as non-root" sh -c "test \"\$(docker exec $name id -u)\" != 0"
    start=$(date +%s)
    docker stop -t 10 "$name" >/dev/null
    expect "stops promptly on SIGTERM" sh -c "test \$(( \$(date +%s) - $start )) -lt 5"
    ;;
  web)
    # No server running: nginx must still start, and /ws must reach the proxy (502), not the SPA.
    docker run -d --name "$name" -p 18080:8080 -e SERVER_URL=http://127.0.0.1:9 "$image" >/dev/null
    wait_for http://127.0.0.1:18080/healthz
    expect "GET / serves the app" sh -c 'curl -fsS http://127.0.0.1:18080/ | grep -q "<canvas id=\"game\""'
    expect "room links fall back to index.html" sh -c 'curl -fsS http://127.0.0.1:18080/r/AAAAAAAAAAAAAAAAAAAAAA | grep -q "<canvas id=\"game\""'
    asset=$(curl -fsS http://127.0.0.1:18080/ | sed -n 's/.*src="\(\/assets\/[^"]*\.js\)".*/\1/p' | head -1)
    expect "hashed JS asset is served immutable" sh -c "curl -fsSI http://127.0.0.1:18080$asset | grep -qi 'cache-control: public, max-age=31536000, immutable'"
    expect "/ws is proxied (502 with no upstream)" sh -c 'test "$(curl -s -o /dev/null -w %{http_code} http://127.0.0.1:18080/ws)" = 502'
    expect "runs as non-root" sh -c "test \"\$(docker exec $name id -u)\" != 0"
    ;;
  *)
    echo "usage: $0 server|web <image>" >&2
    exit 2
    ;;
esac

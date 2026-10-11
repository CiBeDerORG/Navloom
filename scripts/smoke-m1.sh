#!/usr/bin/env bash
set -euo pipefail

base="http://127.0.0.1:5173/api/v1"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
csrf=(-H "x-navloom-csrf: 1" -H "content-type: application/json" -H "Origin: http://127.0.0.1:5173")

expect_code() {
  local want="$1"
  shift
  local got
  got="$(curl -sS -o "$tmp/response.json" -w "%{http_code}" "$@")"
  if [ "$got" != "$want" ]; then
    echo "Expected HTTP $want, received $got"
    cat "$tmp/response.json"
    exit 1
  fi
}

expect_code 401 "$base/home/navigation"
expect_code 403 -X POST -d '{"passphrase":"test-home-1234"}' "$base/auth/home/unlock"
expect_code 200 -c "$tmp/home.cookies" "${csrf[@]}" -X POST -d '{"passphrase":"test-home-1234"}' "$base/auth/home/unlock"
expect_code 200 -b "$tmp/home.cookies" "$base/home/navigation"
expect_code 401 -b "$tmp/home.cookies" "$base/admin/navigation"
expect_code 401 -b "$tmp/home.cookies" "$base/admin/agents"

expect_code 200 -c "$tmp/admin.cookies" "${csrf[@]}" -X POST -d '{"username":"admin","password":"test-admin-password-123"}' "$base/auth/admin/login"
expect_code 200 -b "$tmp/admin.cookies" "$base/admin/navigation"
expect_code 201 -b "$tmp/admin.cookies" "${csrf[@]}" -X POST -d '{"name":"常用"}' "$base/admin/navigation/groups"
group_id="$(jq -r .id "$tmp/response.json")"
expect_code 201 -b "$tmp/admin.cookies" "${csrf[@]}" -X POST -d "{\"title\":\"GitHub\",\"url\":\"https://github.com\",\"groupId\":\"$group_id\"}" "$base/admin/navigation/cards"
expect_code 200 -b "$tmp/home.cookies" "$base/home/navigation"
grep -q 'GitHub' "$tmp/response.json"

expect_code 200 -b "$tmp/admin.cookies" -H "x-navloom-csrf: 1" -H "Origin: http://127.0.0.1:5173" -X DELETE "$base/admin/navigation/groups/$group_id"
expect_code 200 -b "$tmp/admin.cookies" "$base/admin/navigation"
grep -q '"groupId":null' "$tmp/response.json"

expect_code 200 -b "$tmp/admin.cookies" "${csrf[@]}" -X POST -d '{}' "$base/auth/admin/logout"
expect_code 401 -b "$tmp/admin.cookies" "$base/admin/navigation"
echo "M1 end-to-end HTTP smoke passed through Vite proxy"

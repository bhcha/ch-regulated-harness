#!/usr/bin/env bash
# ingest.sh — D9 동결: ingest-bundle.sh 의 alias(래퍼). 가이드 §3 명명과 동기화.
exec bash "$(dirname "${BASH_SOURCE[0]}")/ingest-bundle.sh" "$@"

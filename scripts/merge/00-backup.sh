#!/bin/bash
# 먹선 DB 병합 전 백업 스크립트
# 사용법: bash scripts/merge/00-backup.sh

set -e

TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="meokseon_backup_pre_merge_${TIMESTAMP}.dump"

echo "========================================"
echo "  먹선 DB 병합 전 백업"
echo "  파일: ${BACKUP_FILE}"
echo "========================================"

pg_dump -U postgres -d meokseon -F c -f "${BACKUP_FILE}"

echo ""
echo "  ✅ 백업 완료: ${BACKUP_FILE}"
echo "  크기: $(ls -lh ${BACKUP_FILE} | awk '{print $5}')"
echo "========================================"

#!/usr/bin/env bash
# run_thumbnails_after_convert.sh
# Queues the thumbnail & preview upload task to run automatically once the conversion task finishes.

set -u

LOG_FILE="/home/ubuntu/ws/upload_thumbs.log"
SCRIPT_DIR="/home/ubuntu/anyonsci/image_conversion_scripts/meganz_utils"
TARGET_PID="${1:-184663}"

echo "========================================================" >> "$LOG_FILE"
echo "[$(date -u '+%Y-%m-%d %H:%M:%SZ')] Thumbnails Queue Supervisor started (waiting on PID $TARGET_PID)..." >> "$LOG_FILE"
echo "Monitoring conversion processes before launching thumbnail generation..." >> "$LOG_FILE"

WAIT_ITER=0
while true; do
    IS_CONVERT_RUNNING=0
    if [ -n "$TARGET_PID" ] && kill -0 "$TARGET_PID" 2>/dev/null; then
        IS_CONVERT_RUNNING=1
    elif pgrep -f "node index.js convert" >/dev/null 2>&1; then
        IS_CONVERT_RUNNING=1
    fi

    if [ "$IS_CONVERT_RUNNING" -eq 1 ]; then
        WAIT_ITER=$((WAIT_ITER + 1))
        # Log heartbeat every 20 iterations (5 minutes)
        if [ $((WAIT_ITER % 20)) -eq 0 ]; then
            echo "[$(date -u '+%Y-%m-%d %H:%M:%SZ')] Conversion task is still running. Waiting for CPU to free up..." >> "$LOG_FILE"
        fi
        sleep 15
    else
        break
    fi
done

echo "[$(date -u '+%Y-%m-%d %H:%M:%SZ')] Conversion task has completed. CPU is now free!" >> "$LOG_FILE"
echo "[$(date -u '+%Y-%m-%d %H:%M:%SZ')] Launching thumbnails & preview generator for mummy_parna_26..." >> "$LOG_FILE"

cd "$SCRIPT_DIR" || exit 1

# Runs thumbnail task without --force so all files already having thumbs & preview are skipped
stdbuf -oL -eL node index.js thumbnails \
    --path="mummy_parna_26" \
    --local-dir="/home/ubuntu/ws/parna_avif" \
    >> "$LOG_FILE" 2>&1

EXIT_CODE=$?
echo "[$(date -u '+%Y-%m-%d %H:%M:%SZ')] Thumbnail upload script finished with exit code $EXIT_CODE." >> "$LOG_FILE"
echo "========================================================" >> "$LOG_FILE"

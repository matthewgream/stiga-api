#!/usr/bin/env bash
set -u
CMD="tools/stiga-command.js --robot"
while true; do
    JSON="$(${CMD} status --format json --level quiet 2>/dev/null)"
    echo "${JSON}"
    ZONE="$(echo "${JSON}" | jq -r '.value.mowing.zone // empty')"
    if [ -z "${ZONE}" ]; then
        echo "mower zone is unknown: OK, no action"
    elif [ "${ZONE}" = "1" ] || [ "${ZONE}" = "2" ]; then
        echo "mower zone is ${ZONE}: OK, no action"
    else
        echo "mower zone is ${ZONE}: stopping and sending home"
        ${CMD} stop
        sleep 30
        ${CMD} go-home
        exit 0
    fi
    sleep 30
done

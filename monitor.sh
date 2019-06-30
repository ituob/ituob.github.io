#!/bin/bash -e

logfile=monitor.log
echo "[monitor] Executing command '$@' with redirection to $logfile."
end=$((SECONDS))
$@ 2>&1 > $logfile &
pid=$!

while kill -0 $pid 2> /dev/null; do
  if ! (( $SECONDS % 10 )) ; then
    echo "[monitor] Process $pid running ($SECONDS seconds elapsed)"
  fi
  sleep 1
done

echo "[monitor] Process $pid complete in $SECONDS seconds."

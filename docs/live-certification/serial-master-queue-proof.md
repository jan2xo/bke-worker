# Serial Master Queue Live Certification

## SERIAL-A

Task A was executed by `android-worker-a` as the first live queued task.

## SERIAL-B

Task B executed only after Task A merged and closed, proving the dispatcher advanced the ordered queue from the merged Task A state.

## SERIAL-C

Task C completed the three-task serial proof, executing only after Task B merged and closed.

EXPECTED_POST_MERGE_STATE: NO_RUNNABLE_TASK / WAIT

#!/usr/bin/env python3
"""Bound a command AND its process group; diagnose children without dumping argv/env."""
import os
import signal
import subprocess
import sys
import time


def members(group):
    result = subprocess.run(['ps', '-eo', 'pid,ppid,pgid,stat,comm'], capture_output=True, text=True, check=True)
    return [line for line in result.stdout.splitlines()[1:]
            if line.split()[2] == str(group) and not line.split()[3].startswith('Z')]


def terminate(group, signum):
    try:
        os.killpg(group, signum)
    except ProcessLookupError:
        pass  # The group finished between the process snapshot and the signal.


def run(seconds, command, grace=10, inherit_stdin=False):
    job_start = os.environ.get('CI_JOB_STARTED_AT')
    if job_start:
        # CI_JOB_BUDGET_SECONDS mirrors the job's timeout-minutes (default 15 min).
        # Leave 60s for artifact upload, 10s group cleanup and 10s step overhead.
        budget = int(os.environ.get('CI_JOB_BUDGET_SECONDS', 900))
        seconds = min(seconds, budget - (time.time() - int(job_start)) - 80)
        if seconds <= 0:
            print('Setup exhausted the job budget; preserving artifact/cleanup headroom', flush=True)
            return 124
    started = time.monotonic()
    child = None
    cancelled = False
    interruptible = False
    rc = 1

    def interrupted(_signum, _frame):
        nonlocal cancelled
        cancelled = True
        # During Popen, record cancellation until we have the child PID.
        # During cleanup, do not interrupt the finally block a second time.
        if interruptible:
            raise KeyboardInterrupt

    previous = {sig: signal.getsignal(sig) for sig in (signal.SIGTERM, signal.SIGINT)}
    for sig in previous:
        signal.signal(sig, interrupted)
    try:
        child = subprocess.Popen(command, start_new_session=True,
                                 stdin=None if inherit_stdin else subprocess.DEVNULL)
        interruptible = True
        print(f'Bounded command started: group={child.pid}; deadline={seconds:.3f}s', flush=True)
        if cancelled:
            raise KeyboardInterrupt
        try:
            rc = child.wait(timeout=seconds)
        except subprocess.TimeoutExpired:
            print(f'Deadline exceeded ({seconds}s); process group {child.pid}', flush=True)
            rc = 124
    except KeyboardInterrupt:
        rc = 130
    finally:
        interruptible = False
        if child is not None:
            remaining = members(child.pid)
            if remaining:
                print('Remaining processes (pid ppid pgid stat command):\n' + '\n'.join(remaining), flush=True)
                terminate(child.pid, signal.SIGTERM)
                deadline = time.monotonic() + grace
                while members(child.pid) and time.monotonic() < deadline:
                    time.sleep(0.1)
                if members(child.pid):
                    print('Escalating process group to SIGKILL', flush=True)
                    terminate(child.pid, signal.SIGKILL)
                # Successful Vitest exit with abandoned children is a CI failure.
                if rc == 0:
                    rc = 1
            child.wait()
        for sig, handler in previous.items():
            signal.signal(sig, handler)
        if cancelled:
            rc = 130
        print(f'Bounded command elapsed: {time.monotonic() - started:.3f}s; exit={rc}', flush=True)
    return rc if rc >= 0 else 128 - rc


if __name__ == '__main__':
    args = sys.argv[1:]
    inherit_stdin = args[0] == '--inherit-stdin'
    if inherit_stdin:
        args = args[1:]
    sys.exit(run(float(args[0]), args[1:], inherit_stdin=inherit_stdin))

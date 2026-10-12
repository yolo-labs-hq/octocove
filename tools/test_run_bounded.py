"""Small adversarial process tests; no Vitest/workerd/build involved."""
import importlib.util
import os
from pathlib import Path
import sys
import subprocess
import signal
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('bounded', Path(__file__).with_name('run-bounded.py'))
bounded = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bounded)


class ProcessBudgetTests(unittest.TestCase):
    def test_cancellation_during_launch_still_cleans_up(self):
        spawn = subprocess.Popen
        def cancel_during_launch(*args, **kwargs):
            child = spawn(*args, **kwargs)
            if kwargs.get('start_new_session'):
                os.kill(os.getpid(), signal.SIGTERM)
            return child
        with patch.object(bounded.subprocess, 'Popen', side_effect=cancel_during_launch):
            self.assertEqual(bounded.run(2, [sys.executable, '-c', 'import time; time.sleep(20)']), 130)

    def test_slow_setup_leaves_artifact_budget(self):
        with patch.dict(bounded.os.environ, {'CI_JOB_STARTED_AT': '1000'}), patch.object(bounded.time, 'time', return_value=1821):
            # Do not spawn even a trivial command once only reserved time remains.
            with patch.object(bounded.subprocess, 'Popen') as spawn:
                self.assertEqual(bounded.run(600, ['unused']), 124)
                spawn.assert_not_called()

    def test_job_budget_follows_configured_timeout(self):
        env = {'CI_JOB_STARTED_AT': '1000', 'CI_JOB_BUDGET_SECONDS': '780'}
        with patch.dict(bounded.os.environ, env), patch.object(bounded.time, 'time', return_value=1701):
            # 701s used of a 780s job: only the reserved 80s remain.
            with patch.object(bounded.subprocess, 'Popen') as spawn:
                self.assertEqual(bounded.run(600, ['unused']), 124)
                spawn.assert_not_called()

    def test_preserves_exit_status(self):
        self.assertEqual(bounded.run(2, [sys.executable, '-c', 'raise SystemExit(7)']), 7)

    def test_deadline_kills_term_ignoring_child(self):
        self.assertEqual(bounded.run(0.2, [sys.executable, '-c',
            'import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(20)'], grace=0.2), 124)

    def test_success_with_abandoned_child_fails(self):
        self.assertEqual(bounded.run(2, [sys.executable, '-c',
            'import subprocess,sys; subprocess.Popen([sys.executable,"-c","import time; time.sleep(20)"])'], grace=0.2), 1)

    def test_clean_success(self):
        self.assertEqual(bounded.run(2, [sys.executable, '-c', 'pass']), 0)

    def test_fixture_stdin_and_signal_status(self):
        result = subprocess.run([sys.executable, str(Path(__file__).with_name('run-bounded.py')),
            '--inherit-stdin', '2', sys.executable, '-c',
            'import sys,os,signal; assert sys.stdin.read()=="fixture"; os.kill(os.getpid(),signal.SIGKILL)'],
            input='fixture', text=True, capture_output=True, timeout=5)
        self.assertEqual(result.returncode, 137, result.stdout + result.stderr)

    def test_cancellation_cleans_the_process_group(self):
        child = subprocess.Popen([sys.executable, str(Path(__file__).with_name('run-bounded.py')),
            '20', sys.executable, '-c', 'import time; print("ready",flush=True); time.sleep(20)'], stdout=subprocess.PIPE, text=True)
        while not child.stdout.readline().startswith('Bounded command started:'):
            if child.poll() is not None:
                self.fail('supervisor exited before launch handshake')
        child.send_signal(signal.SIGTERM)
        output, _ = child.communicate(timeout=3)
        self.assertEqual(child.returncode, 130, output)
        self.assertIn('Remaining processes', output)


if __name__ == '__main__':
    unittest.main()

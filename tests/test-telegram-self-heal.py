import os
import pathlib
import subprocess
import tempfile
import unittest

SCRIPT = pathlib.Path(__file__).resolve().parents[1] / 'scripts/telegram-lane-self-heal.sh'


class RecoveryTest(unittest.TestCase):
    def setUp(self):
        root = SCRIPT.parent.parent / '.tmp'
        root.mkdir(exist_ok=True)
        self.tmp = tempfile.TemporaryDirectory(dir=root)
        self.addCleanup(self.tmp.cleanup)
        self.root = pathlib.Path(self.tmp.name)
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        mocks = {
            'timeout': '''#!/bin/bash
shift
if [[ "$1" == bash ]]; then
  [[ "$*" == *2228* ]] && exit "${MANAGEMENT_FAIL:-0}"
  exit "${UPSTREAM_FAIL:-0}"
fi
exec "$@"
''',
            'ssh': '''#!/bin/bash
if [[ "$*" == *"ha apps restart"* ]]; then
 echo restart >> "$TEST_ROOT/actions"
 touch "$TEST_ROOT/recovered"
 exit 0
fi
if [[ "$*" == *"docker inspect"* ]]; then
 [[ -e "$TEST_ROOT/recovered" ]] && exit 0
 exit "${STACK_FAIL:-0}"
fi
exit 0
''',
            'sleep': '#!/bin/bash\nexit 0\n',
            'dig': '#!/bin/bash\n[[ "${DNS_FAIL:-0}" == 1 ]] && exit 1\necho HEADER\n',
        }
        for name, text in mocks.items():
            p = self.bin / name
            p.write_text(text)
            p.chmod(0o755)
        self.env = dict(os.environ, PATH=f'{self.bin}:/usr/bin:/bin', TEST_ROOT=str(self.root),
                        TELEGRAM_LANE_STATE_DIR=str(self.root / 'state'),
                        TELEGRAM_LANE_MAX_DYNAMIC_DCS='0')

    def run_cycle(self, *args, **env):
        return subprocess.run(['bash', str(SCRIPT), *args], env=dict(self.env, **env),
                              capture_output=True, text=True, check=True).stdout

    def actions(self):
        p = self.root / 'actions'
        return p.read_text().splitlines() if p.exists() else []

    def test_healthy_never_restarts(self):
        self.run_cycle()
        self.assertEqual(self.actions(), [])

    def test_upstream_outage_does_not_restart_dns(self):
        for _ in range(3):
            self.run_cycle(UPSTREAM_FAIL='1')
        self.assertEqual(self.actions(), [])

    def test_two_local_failures_recover_once(self):
        self.run_cycle(STACK_FAIL='1')
        self.assertEqual(self.actions(), [])
        self.assertIn('lane healthy again', self.run_cycle(STACK_FAIL='1'))
        self.assertEqual(self.actions(), ['restart'])
        self.run_cycle(STACK_FAIL='1')
        self.assertEqual(self.actions(), ['restart'])

    def test_cooldown_bounds_persistent_failure(self):
        self.run_cycle(STACK_FAIL='1')
        self.run_cycle(STACK_FAIL='1')
        (self.root / 'recovered').unlink()
        self.assertIn('cooldown active', self.run_cycle(STACK_FAIL='1'))
        self.assertEqual(self.actions(), ['restart'])

    def test_unreachable_management_does_not_restart(self):
        self.run_cycle(MANAGEMENT_FAIL='1', STACK_FAIL='1')
        self.assertEqual(self.actions(), [])

    def test_dry_run_never_mutates_service(self):
        self.run_cycle('--dry-run', STACK_FAIL='1')
        self.assertIn('would restart app_27579e22', self.run_cycle('--dry-run', STACK_FAIL='1'))
        self.assertEqual(self.actions(), [])

    def test_unresponsive_dns_triggers_bounded_recovery(self):
        self.run_cycle(DNS_FAIL='1')
        self.run_cycle(DNS_FAIL='1')
        self.assertEqual(self.actions(), ['restart'])
        self.assertIn('cooldown active', self.run_cycle(DNS_FAIL='1'))


if __name__ == '__main__':
    unittest.main()

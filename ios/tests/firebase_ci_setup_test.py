from pathlib import Path
import json
import os
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/setup-firebase-ci.sh"


class SetupTests(unittest.TestCase):
    def test_creation_and_rerun_keep_repository_scoped_trust(self):
        for exists in [False, True]:
            with tempfile.TemporaryDirectory(prefix="contour-ci-setup-") as root:
                folder = Path(root)
                gcloud = folder / "gcloud"
                gcloud.write_text('''#!/usr/bin/env python3
import sys,json,os
args=sys.argv[1:]
with open(os.environ['GCLOUD_CALLS'],'a') as file:file.write(json.dumps(args)+'\\n')
if args[:2]==['projects','describe']:print('223430657240')
if 'describe' in args and args[0]=='iam' and os.environ['RESOURCES_EXIST']=='0':sys.exit(1)
''')
                gcloud.chmod(0o755)
                calls_file = folder / "calls"
                env = {**os.environ, "PATH": root + os.pathsep + os.environ["PATH"],
                       "GCLOUD_CALLS": str(calls_file), "RESOURCES_EXIST": "1" if exists else "0"}
                result = subprocess.run(["bash", str(SCRIPT)], env=env, capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                calls = [json.loads(line) for line in calls_file.read_text().splitlines()]
                provider = next(c for c in calls if any("--attribute-condition=" in a for a in c))
                condition = next(a for a in provider if a.startswith("--attribute-condition="))
                for gate in ["repository_id == '1445568390'", "repository_owner_id == '224859517'",
                             "event_name == 'workflow_dispatch'", "refs/heads/david/kmp-ios"]:
                    self.assertIn(gate, condition)
                self.assertIn("update-oidc" if exists else "create-oidc", provider)
                grants = [c for c in calls if "add-iam-policy-binding" in c and c[0] == "projects"]
                self.assertEqual(len(grants), 2)
                self.assertFalse(any("roles/editor" in a or "datastore" in a for c in calls for a in c))
                self.assertIn("GCP_SERVICE_ACCOUNT=contour-ios-distribution@", result.stdout)


if __name__ == "__main__":
    unittest.main()

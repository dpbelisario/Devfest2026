"""Run with python3 -m unittest discover -s ios/tests -p '*_test.py'."""

import base64
import copy
import datetime
import json
import os
from pathlib import Path
import plistlib
import re
import subprocess
import sys
import tempfile
import textwrap
import unittest


class FirebaseWorkflowTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        root = Path(__file__).resolve().parents[2]
        workflow = (root / ".github/workflows/ios-firebase.yml").read_text()
        block = re.search(r"(?ms)^([ ]+)python3 - <<'PY'\n(.*?)^\1PY$", workflow)
        if block is None:
            raise AssertionError("Workflow preflight Python block was not found")
        cls.preflight = textwrap.dedent(block[2])
        compile(cls.preflight, "workflow preflight", "exec")
        cls.app = json.loads((root / "ios/firebase-app.json").read_text())
        try:
            version = subprocess.check_output(["openssl", "version"], text=True)
        except FileNotFoundError:
            raise unittest.SkipTest("OpenSSL 3 is required for PKCS12/CMS fixtures")
        if not version.startswith("OpenSSL 3."):
            raise unittest.SkipTest("OpenSSL 3 is required for the workflow's -legacy option")

    def openssl(self, *arguments):
        subprocess.run(["openssl", *arguments], check=True, capture_output=True)

    def test_signed_profile_preflight(self):
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            (directory / "ios").mkdir()
            (directory / "ios/firebase-app.json").write_text(json.dumps(self.app))
            key, certificate = directory / "key.pem", directory / "certificate.pem"
            self.openssl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", str(key), "-out", str(certificate), "-subj", "/CN=Workflow Test Fixture", "-days", "1")
            self.openssl("pkcs12", "-export", "-inkey", str(key), "-in", str(certificate), "-out", str(directory / "certificate.p12"), "-passout", "pass:test-only")
            profile = {
                "ExpirationDate": datetime.datetime.now() + datetime.timedelta(days=1),
                "ProvisionedDevices": ["fixture-device"],
                "TeamIdentifier": ["ABCDEFGHIJ"],
                "UUID": "ABCDEF01-2345-6789-ABCD-0123456789AB",
                "Entitlements": {"get-task-allow": False, "application-identifier": "ABCDEFGHIJ." + self.app["bundleId"]},
            }
            cases = [
                ("valid", {}, True),
                ("expired", {"ExpirationDate": datetime.datetime.now() - datetime.timedelta(days=1)}, False),
                ("no devices", {"ProvisionedDevices": []}, False),
                ("wrong team", {"TeamIdentifier": ["WRONGTEAM1"]}, False),
                ("enterprise", {"ProvisionsAllDevices": True}, False),
                ("development", {"Entitlements": {**profile["Entitlements"], "get-task-allow": True}}, False),
                ("wrong bundle", {"Entitlements": {**profile["Entitlements"], "application-identifier": "ABCDEFGHIJ.other.app"}}, False),
            ]

            for label, changes, expected in cases:
                with self.subTest(label=label):
                    candidate = copy.deepcopy(profile)
                    candidate.update(changes)
                    (directory / "profile.plist").write_bytes(plistlib.dumps(candidate))
                    self.openssl("cms", "-sign", "-binary", "-nodetach", "-in", str(directory / "profile.plist"), "-signer", str(certificate), "-inkey", str(key), "-outform", "DER", "-out", str(directory / "profile.cms"))
                    environment = {
                        **os.environ,
                        "DISTRIBUTION": "firebase",
                        "IOS_TEAM_ID": "ABCDEFGHIJ",
                        "IOS_DISTRIBUTION_CERTIFICATE_BASE64": base64.b64encode((directory / "certificate.p12").read_bytes()).decode(),
                        "IOS_DISTRIBUTION_CERTIFICATE_PASSWORD": "test-only",
                        "IOS_AD_HOC_PROFILE_BASE64": base64.b64encode((directory / "profile.cms").read_bytes()).decode(),
                        "GITHUB_OUTPUT": str(directory / "output"),
                    }
                    result = subprocess.run([sys.executable, "-c", self.preflight], cwd=directory, env=environment, capture_output=True)
                    self.assertEqual(result.returncode == 0, expected, result.stderr.decode())
                    if expected:
                        self.assertIn("profile_uuid=" + profile["UUID"], (directory / "output").read_text())


if __name__ == "__main__":
    unittest.main()

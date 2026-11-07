import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location(
    "setup_firebase", Path(__file__).resolve().parents[1] / "scripts/setup-firebase.py"
)
setup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(setup)


class RegistrationTests(unittest.TestCase):
    config = {"projectId": "demo-project", "bundleId": "com.example.app", "displayName": "Demo"}

    def test_existing_app_is_reused_without_creating_another(self):
        app = {"bundleId": "com.example.app", "appId": "existing"}
        calls = []
        def request(path, data=None):
            calls.append((path, data))
            return {"apps": [{"bundleId": "another.app"}, app]}
        self.assertEqual(setup.register(self.config, request), app)
        self.assertEqual(calls, [("projects/demo-project/iosApps", None)])

    def test_created_app_waits_for_operation_and_propagates_failure(self):
        for fail in [False, True]:
            calls = []
            def request(path, data=None):
                calls.append((path, data))
                if len(calls) == 1:
                    return {}
                if data is not None:
                    return {"name": "operations/new-app"}
                return {"done": True, "error": {"message": "Denied"}} if fail else {
                    "done": True, "response": {"appId": "created"}
                }
            if fail:
                with self.assertRaisesRegex(RuntimeError, "Denied"):
                    setup.register(self.config, request, lambda _: None)
            else:
                self.assertEqual(setup.register(self.config, request, lambda _: None), {"appId": "created"})
            self.assertEqual(calls[1][1]["bundleId"], self.config["bundleId"])
            self.assertEqual(calls[2][0], "operations/new-app")


if __name__ == "__main__":
    unittest.main()

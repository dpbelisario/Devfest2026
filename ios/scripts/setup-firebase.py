#!/usr/bin/env python3
"""Register or find this repository's Firebase iOS app using Cloud Shell login."""
import json
from pathlib import Path
import subprocess
import sys
import time
import urllib.error
import urllib.request

CONFIG = Path(__file__).resolve().parents[1] / "firebase-app.json"
BASE = "https://firebase.googleapis.com/v1beta1/"


def register(config, request, pause=time.sleep):
    path = "projects/" + config["projectId"] + "/iosApps"
    for app in request(path).get("apps", []):
        if app.get("bundleId") == config["bundleId"]:
            return app
    operation = request(path, {
        "bundleId": config["bundleId"], "displayName": config["displayName"]
    })
    for _ in range(60):
        if operation.get("done"):
            if "error" in operation:
                raise RuntimeError(operation["error"].get("message", "Registration failed"))
            return operation["response"]
        pause(1)
        operation = request(operation["name"])
    raise RuntimeError("Registration still pending: " + operation["name"])


def main():
    config = json.loads(CONFIG.read_text())
    result = subprocess.run(
        ["gcloud", "auth", "print-access-token"], capture_output=True, text=True
    )
    if result.returncode:
        raise RuntimeError("Sign in to Google Cloud or run this in Cloud Shell.")
    headers = {
        "Authorization": "Bearer " + result.stdout.strip(),
        "x-goog-user-project": config["projectId"],
        "Content-Type": "application/json",
    }

    def request(path, data=None):
        payload = json.dumps(data).encode() if data is not None else None
        req = urllib.request.Request(BASE + path, headers=headers, data=payload)
        with urllib.request.urlopen(req, timeout=30) as response:
            return json.load(response)

    app = register(config, request)
    metadata = {key: app[key] for key in ["projectId", "appId", "bundleId", "displayName"]}
    CONFIG.write_text(json.dumps(metadata, indent=2) + "\n")
    print(json.dumps(metadata, indent=2))


if __name__ == "__main__":
    try:
        main()
    except urllib.error.HTTPError as error:
        detail = json.loads(error.read()).get("error", {}).get("message", error.reason)
        print("Firebase registration failed: " + str(detail), file=sys.stderr)
        sys.exit(1)
    except (OSError, RuntimeError, KeyError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)

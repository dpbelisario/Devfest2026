const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { spawnSync } = require("node:child_process");
const script = resolve(__dirname, "../scripts/build-shared.sh");
test("Xcode build honors JAVA_HOME and fails clearly for a missing JDK", () => {
  const root = mkdtempSync(join(tmpdir(), "contour-build-"));
  try {
    mkdirSync(join(root, "ios"));
    mkdirSync(join(root, "android"));
    mkdirSync(join(root, "jdk/bin"), { recursive: true });
    writeFileSync(join(root, "jdk/bin/java"), "#!/bin/sh\nexit 0\n", {
      mode: 0o755,
    });
    writeFileSync(
      join(root, "android/gradlew"),
      '#!/bin/sh\nprintf "%s" "$1"\n',
      { mode: 0o755 },
    );
    const env = {
      ...process.env,
      SRCROOT: join(root, "ios"),
      JAVA_HOME: join(root, "jdk"),
    };
    const result = spawnSync("/bin/sh", [script], { env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, ":shared:embedAndSignAppleFrameworkForXcode");
    const missing = spawnSync("/bin/sh", [script], {
      env: { ...env, JAVA_HOME: join(root, "missing") },
      encoding: "utf8",
    });
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /Set JAVA_HOME/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

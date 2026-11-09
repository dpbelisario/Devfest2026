#!/bin/bash
set -euo pipefail
: "${IOS_DEVICE_UDID:?Set IOS_DEVICE_UDID to the connected iPhone UDID}"
: "${IOS_TEAM_ID:?Set IOS_TEAM_ID to your Xcode Personal Team or paid team}"
: "${IOS_BUNDLE_ID:?Set IOS_BUNDLE_ID to your locally signed app identifier}"
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
export JAVA_HOME="${JAVA_HOME:-$(/usr/libexec/java_home -v 17)}"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
cd "$(dirname "$0")/.."
# One source feeds Hosting, Android assets and the Xcode resources phase.
npm run build
node --test ios/tests/bridge.test.cjs ios/tests/build-shared.test.cjs
contour_derived_data="${CONTOUR_DERIVED_DATA:-$PWD/ios/DerivedData}"
xcodebuild -quiet -project ios/Contour.xcodeproj -scheme Contour -configuration Debug \
  -destination "platform=iOS,id=$IOS_DEVICE_UDID" -derivedDataPath "$contour_derived_data" \
  "DEVELOPMENT_TEAM=$IOS_TEAM_ID" "PRODUCT_BUNDLE_IDENTIFIER=$IOS_BUNDLE_ID" \
  -allowProvisioningUpdates build
contour_app="$contour_derived_data/Build/Products/Debug-iphoneos/Contour.app"
cmp android/app/src/main/assets/contour.html "$contour_app/contour.html"
xcrun devicectl device install app --device "$IOS_DEVICE_UDID" "$contour_app"
xcrun devicectl device process launch --device "$IOS_DEVICE_UDID" "$IOS_BUNDLE_ID"

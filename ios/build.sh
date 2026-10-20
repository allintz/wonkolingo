#!/bin/zsh
# Build the iPhone app's web content and Xcode project: web build -> copy into the app -> regenerate the project.
set -e
cd "$(dirname "$0")/.."
./build.sh
npx cap sync ios
(cd ios/App && xcodegen generate --quiet)

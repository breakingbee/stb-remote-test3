# Building the .ipa

This is an Expo/React Native app. Producing an actual `.ipa` requires Apple's
toolchain (Xcode + a Mac, or Apple's cloud build service) — that step can't happen in
this sandbox, which has no macOS/Xcode/code-signing available. Two real paths:

## Option A — EAS Build (no Mac needed)

```bash
npm install
npx eas-cli login
npx eas build --platform ios --profile production
```

You'll need a free or paid Expo (EAS) account and an Apple Developer account (for the
provisioning profile/signing identity) — EAS walks you through generating both if you
don't already have them. This produces a downloadable `.ipa` from Expo's cloud
builders.

## Option B — Local Xcode build (Mac required)

```bash
npm install
npx expo prebuild -p ios     # generates the ios/ native project
cd ios && pod install
open StbRemote.xcworkspace   # (name from app.config.ts)
```

Then in Xcode: select your team under Signing & Capabilities, pick a physical device
or "Any iOS Device", and Product → Archive → Distribute App.

## Option C — GitHub Actions macOS runner (no EAS, no paid Apple Developer account)

`.github/workflows/build-ios.yml` builds an **unsigned** IPA on GitHub's hosted macOS
runner: `expo prebuild` → `pod install` → `xcodebuild archive` with code signing
disabled → zipped into an unsigned `.ipa` artifact. No Expo account, no Apple
Developer Program membership, no signing certificate needed.

```bash
git add .github/workflows/build-ios.yml
git commit -m "Add unsigned-IPA CI build"
git push
```

Push to `main` (or run it manually from the Actions tab — it's also wired to
`workflow_dispatch`) and it runs automatically. When it finishes, download the
`StbRemote-unsigned-ipa` artifact from the workflow run's summary page.

Being unsigned means you can't install it directly from Xcode/TestFlight — you'll
need a sideloading tool that can (re)sign or install unsigned/ad-hoc IPAs on your own
device, such as AltStore, Sideloadly, or your own signing step added to the workflow
later if you get a developer account. That installation step is outside this repo's
scope since it depends on which sideloading method you use.

## Before either build

- `react-native-udp` requires a **native build** — it will not work in Expo Go. All
  options above produce a real native build, so this isn't an extra step, just a note
  for local testing: `npx expo start` alone (Expo Go) will only show the UI, not send
  real packets.
- The app needs Local Network permission on iOS (for UDP + SSDP on the LAN) — this is
  already declared via `expo-build-properties`/Info.plist entries; if you add new
  native modules, re-run `expo prebuild` to regenerate `ios/`.
- Protocol tests (`npx vitest run`) and typecheck (`npx tsc --noEmit`) are useful to
  run locally before pushing, but neither is part of the CI workflow — the workflow
  only builds the archive, it doesn't gate on tests.

import "./scripts/load-env.js";
import type { ExpoConfig } from "expo/config";

const config: ExpoConfig = {
  name: "STB Remote Claude",
  slug: "stb-remote-claude",
  version: "1.0.0",
  orientation: "portrait",
  icon: "./assets/images/icon.png",
  userInterfaceStyle: "dark",
  newArchEnabled: true,
  ios: {
    supportsTablet: true,
    bundleIdentifier: "com.app.stbremoteclaude",
    infoPlist: {
      ITSAppUsesNonExemptEncryption: false,
      NSLocalNetworkUsageDescription: "STB Remote discovers and controls set-top boxes on your local network.",
      NSAppTransportSecurity: { NSAllowsArbitraryLoadsInLocalNetworking: true },
    },
  },
  android: { package: "com.app.stbremoteclaude" },
  plugins: [
    "expo-router",
    ["expo-splash-screen", { image: "./assets/images/splash-icon.png", imageWidth: 200, resizeMode: "contain", backgroundColor: "#ffffff", dark: { backgroundColor: "#000000" } }],
  ],
  experiments: { typedRoutes: true, reactCompiler: true },
};

export default config;

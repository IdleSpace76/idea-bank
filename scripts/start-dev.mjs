import { launchLocal } from "./local-launch.mjs";
await launchLocal("dev", process.argv.slice(2), { openBrowser: true });

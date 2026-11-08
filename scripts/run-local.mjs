import { launchLocal } from "./local-launch.mjs";
await launchLocal(process.argv[2], process.argv.slice(3));

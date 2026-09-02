// The module Bun.cron runs, if you choose Bun's scheduler over the launchd plist.
//
// Shape is Cloudflare Workers' Cron Trigger API: a default export with `scheduled()`.
// Bun spawns a fresh process per invocation, so there is no shared state between runs —
// the same execution model as launchd, which is what actually runs today.
//
// No `--dry` here, by design (DESIGN §1 and §6): the scheduled job writes.
import { runDaily } from "./run.ts";
import * as log from "./log.ts";

export default {
  async scheduled(controller: Bun.CronController): Promise<void> {
    log.record("scheduled", { cron: controller.cron, scheduledTime: controller.scheduledTime });
    await runDaily({ dry: false });
  },
};

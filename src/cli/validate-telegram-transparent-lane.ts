import { loadTelegramTransparentLaneConfig, renderTelegramTransparentLaneValidation } from "../telegram-transparent-lane.js";

const config = await loadTelegramTransparentLaneConfig();
process.stdout.write(`${JSON.stringify(renderTelegramTransparentLaneValidation(config), null, 2)}\n`);

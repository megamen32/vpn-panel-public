import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  loadTelegramTransparentLaneConfig,
  renderTelegramTransparentLaneCandidate,
} from "../telegram-transparent-lane.js";

const basePath = path.join(process.cwd(), "deploy/server-88/xray/config.json");
const base = JSON.parse(await readFile(basePath, "utf8")) as Record<string, any>;
const lane = await loadTelegramTransparentLaneConfig();
const candidate = renderTelegramTransparentLaneCandidate(base, lane);
process.stdout.write(`${JSON.stringify(candidate, null, 2)}\n`);

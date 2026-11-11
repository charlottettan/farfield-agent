// Readers that understand one site's page structure. Each takes the reader's flat node list and returns { turns, composer } or null.
import { geminiTurns } from "./gemini.js";
import { claudeTurns } from "./claude.js";
export const ADAPTERS = { gemini: geminiTurns, claude: claudeTurns };

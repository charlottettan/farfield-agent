// Readers that understand one site's page structure. Each takes the reader's flat node list and returns { turns, composer } or null.
import { geminiTurns } from "./gemini.js";
import { claudeTurns } from "./claude.js";
export const ADAPTERS = { gemini: geminiTurns, claude: claudeTurns };

// Where to look first on a long page. Claude keeps every message in one list that can be enormous, and only the latest matter.
export const HINTS = { claude: { focus: "Chat messages", tail: 1500 } };
export const hintsFor = (toolId) => HINTS[toolId] || {};

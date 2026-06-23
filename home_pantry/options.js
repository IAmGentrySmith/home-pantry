import fs from 'fs';

let cachedOptions = null;

/**
 * Reads and caches the Home Assistant add-on options.
 * The options file is static after startup, so we cache it on first read.
 * Call clearOptionsCache() if you ever need to force a re-read.
 */
export function getOptions() {
  if (cachedOptions) return cachedOptions;

  try {
    const optionsPath = process.env.OPTIONS_PATH || '/data/options.json';
    if (fs.existsSync(optionsPath)) {
      const data = fs.readFileSync(optionsPath, 'utf8');
      cachedOptions = JSON.parse(data);
      return cachedOptions;
    }
  } catch (err) {
    console.error("Error reading options.json:", err.message);
  }
  
  cachedOptions = {
    todo_list_entity_id: "todo.shopping_list",
    llm_provider: "none",
    llm_api_key: "",
    llm_model: "gpt-4o-mini",
    ha_agent_id: ""
  };
  return cachedOptions;
}

export function clearOptionsCache() {
  cachedOptions = null;
}

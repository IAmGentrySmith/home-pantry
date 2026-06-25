import axios from 'axios';
import { getOptions } from './options.js';
import { log } from './logger.js';

// Get base URL and token.
const haBaseUrl = process.env.SUPERVISOR_TOKEN ? 'http://supervisor/core/api' : (process.env.HA_URL || '');
const haToken = process.env.SUPERVISOR_TOKEN || process.env.HA_TOKEN || '';

const client = axios.create({
  baseURL: haBaseUrl,
  headers: {
    'Authorization': `Bearer ${haToken}`,
    'Content-Type': 'application/json'
  },
  timeout: 10000
});

export async function addItemsToShoppingList(itemName) {
  if (!haBaseUrl || !haToken) return;
  const options = getOptions();
  const entityId = options.todo_list_entity_id || 'todo.shopping_list';

  // Look up current items so we can skip a duplicate. todo.get_items returns its
  // result ONLY via the service response, so we must pass return_response or the
  // Core API rejects the call with HTTP 400. Keep this in its own try: a
  // get_items problem must NOT stop us from adding the item below.
  let items = [];
  try {
    const getRes = await client.post('/services/todo/get_items?return_response=true', {
      entity_id: entityId,
      status: 'needs_action',
    });
    // return_response shape: { service_response: { <entityId>: { items: [...] } } }.
    // Fall back to older array/`response` shapes just in case.
    const data = getRes.data || {};
    const sr = data.service_response || data.response || data;
    const container = Array.isArray(sr) ? sr[0] : sr;
    if (container && container[entityId] && Array.isArray(container[entityId].items)) {
      items = container[entityId].items;
    }
  } catch (err) {
    log.warning(
      'todo.get_items failed; adding without a duplicate check: ' +
        (err.response?.data ? JSON.stringify(err.response.data) : err.message)
    );
  }

  try {
    const exists = items.some(i => i.summary && i.summary.toLowerCase() === itemName.toLowerCase());
    if (exists) {
      log.info(`Item ${itemName} is already on the shopping list. Skipping.`);
      return;
    }
    await client.post('/services/todo/add_item', { entity_id: entityId, item: itemName });
    log.info(`Added ${itemName} to ${entityId}`);
  } catch (err) {
    log.error(
      'Error adding to HA todo list:',
      err.response?.data ? JSON.stringify(err.response.data) : err.message
    );
  }
}

export async function updateExpiringSensor(expiringCount, expiringItems) {
  if (!haBaseUrl || !haToken) return;
  try {
    await client.post('/states/sensor.pantry_expiring_items', {
      state: expiringCount.toString(),
      attributes: {
        friendly_name: "Pantry Expiring Items",
        icon: "mdi:food-apple-outline",
        items: expiringItems
      }
    });
    log.info(`Updated sensor.pantry_expiring_items: ${expiringCount}`);
  } catch (err) {
    log.error("Error updating HA sensor:", err.message);
  }
}

export async function processConversation(text, agentId) {
  if (!haBaseUrl || !haToken) return null;
  try {
    const payload = { text };
    if (agentId) payload.agent_id = agentId;
    
    const res = await client.post('/services/conversation/process', payload);
    // Return the response data from the service call
    const data = res.data;
    if (Array.isArray(data) && data.length > 0 && data[0].response && data[0].response.speech) {
        return data[0].response.speech.plain.speech;
    }
    // Return default response format if new 2023.7+ response structure is used
    if (data.response && data.response.speech) {
        return data.response.speech.plain.speech;
    }
  } catch (err) {
    log.error("Error processing HA conversation:", err.response?.data || err.message);
  }
  return null;
}

/**
 * Generate data with a Home Assistant AI Task entity (ai_task.generate_data).
 *
 * Lets Home Pantry reuse whatever LLM the user has already configured in HA
 * (Anthropic/Claude, OpenAI, Google, Ollama, ...) without storing an API key
 * here. `entityId` selects a specific ai_task.* entity; omit it to use the
 * user's preferred AI Task entity.
 *
 * @returns {string|null} the generated text, or null on error / no response.
 */
export async function generateAiTaskData(prompt, entityId) {
  if (!haBaseUrl || !haToken) return null;
  try {
    const payload = {
      task_name: 'Pantry shelf life estimate',
      instructions: prompt
    };
    if (entityId) payload.entity_id = entityId;

    // ai_task.generate_data returns its result only via the service response,
    // so we must request it explicitly — without ?return_response the Core API
    // rejects the call with a 400.
    const res = await client.post('/services/ai_task/generate_data?return_response=true', payload);
    const data = res.data?.service_response?.data;
    if (data != null) {
      return typeof data === 'string' ? data : String(data);
    }
  } catch (err) {
    log.error("Error calling HA AI Task:", err.response?.data || err.message);
  }
  return null;
}

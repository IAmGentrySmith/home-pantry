import axios from 'axios';
import { getOptions } from './options.js';

// Get base URL and token.
const haBaseUrl = process.env.SUPERVISOR_TOKEN ? 'http://supervisor/core/api' : (process.env.HA_URL || '');
const haToken = process.env.SUPERVISOR_TOKEN || process.env.HA_TOKEN || '';

const client = axios.create({
  baseURL: haBaseUrl,
  headers: {
    'Authorization': `Bearer ${haToken}`,
    'Content-Type': 'application/json'
  }
});

export async function addItemsToShoppingList(itemName) {
  if (!haBaseUrl || !haToken) return;
  const options = getOptions();
  const entityId = options.todo_list_entity_id || 'todo.shopping_list';
  
  try {
    // Check if the item already exists and is incomplete
    const getRes = await client.post('/services/todo/get_items', {
      entity_id: entityId,
      status: 'needs_action'
    });
    
    // The response data format depends on the HA version, but usually it's {"todo.shopping_list": {"items": [...]}}
    let items = [];
    if (getRes.data) {
      // In newer HA versions, response data from services is an object, but some might be arrays
      const data = Array.isArray(getRes.data) ? getRes.data[0] : getRes.data;
      if (data && data.response && data.response[entityId]) {
        items = data.response[entityId].items || [];
      } else if (data && data[entityId]) {
        items = data[entityId].items || [];
      }
    }
    
    const exists = items.some(i => i.summary && i.summary.toLowerCase() === itemName.toLowerCase());
    if (exists) {
      console.log(`Item ${itemName} is already on the shopping list. Skipping.`);
      return;
    }

    await client.post('/services/todo/add_item', {
      entity_id: entityId,
      item: itemName
    });
    console.log(`Added ${itemName} to ${entityId}`);
  } catch (err) {
    console.error("Error adding to HA todo list:", err.message);
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
    console.log(`Updated sensor.pantry_expiring_items: ${expiringCount}`);
  } catch (err) {
    console.error("Error updating HA sensor:", err.message);
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
    console.error("Error processing HA conversation:", err.response?.data || err.message);
  }
  return null;
}

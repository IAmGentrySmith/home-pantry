import axios from 'axios';
import { getOptions } from './options.js';
import { processConversation } from './ha_api.js';
import { parseShelfLifeDays } from './helpers.js';
import { log } from './logger.js';

/**
 * Estimate shelf life for a product using the configured LLM provider.
 * 
 * @returns {{ days: number, llm_used: boolean }} — `llm_used` is true only when
 *   the configured LLM provider successfully returned an estimate.
 */
export async function estimateShelfLife(productName, category) {
  const options = getOptions();
  
  // No LLM configured — use 14-day default
  if (options.llm_provider === 'none') {
    return { days: 14, llm_used: false };
  }

  // External LLM providers require an API key
  if (['openai', 'gemini'].includes(options.llm_provider) && !options.llm_api_key) {
    log.warning(`LLM provider "${options.llm_provider}" selected but no API key provided. Defaulting to 14 days.`);
    return { days: 14, llm_used: false };
  }
  
  const prompt = `Based on the product name "${productName}" and category "${category}", estimate its typical shelf life in days after purchase. Respond ONLY with an integer representing the number of days. If the item is non-perishable (like cleaning supplies, paper goods, etc), return 0. If you are unsure, default to 14. Do not include any other text.`;

  try {
    if (options.llm_provider === 'openai') {
      const res = await axios.post('https://api.openai.com/v1/chat/completions', {
        model: options.llm_model || 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1
      }, {
        headers: {
          'Authorization': `Bearer ${options.llm_api_key}`,
          'Content-Type': 'application/json'
        },
        timeout: 15000
      });
      const text = res.data.choices[0].message.content.trim();
      return { days: parseShelfLifeDays(text), llm_used: true };
    }
    else if (options.llm_provider === 'gemini') {
      const model = options.llm_model || 'gemini-1.5-flash';
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
      // Pass the key as a header, not a query string, so it can't leak via logs/proxies.
      const res = await axios.post(url, {
        contents: [{ parts: [{ text: prompt }] }]
      }, {
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': options.llm_api_key
        },
        timeout: 15000
      });
      const text = res.data.candidates[0].content.parts[0].text.trim();
      return { days: parseShelfLifeDays(text), llm_used: true };
    }
    else if (options.llm_provider === 'ha_conversation') {
      const responseText = await processConversation(prompt, options.ha_agent_id);
      if (responseText) {
        return { days: parseShelfLifeDays(responseText), llm_used: true };
      }
      // processConversation returned null — HA Conversation is misconfigured or unavailable
      log.warning('ha_conversation provider returned no response. Is the Conversation integration configured?');
    }
  } catch (err) {
    // Redact URLs that may contain API keys
    const safeMessage = err.response?.data
      ? JSON.stringify(err.response.data)
      : err.message;
    log.error("LLM Error:", safeMessage);
  }
  
  return { days: 14, llm_used: false };
}

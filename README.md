# Home Pantry Add-on

A lightweight, fully local Home Assistant Add-on to manage your kitchen grocery and pantry inventory.

## Features
- **Barcode Scanning**: Built-in HTML5 camera scanner designed perfectly for the iOS/Android Companion Apps.
- **Smart Data Entry**: Automatically queries the Open Food Facts API to identify products based on their UPC barcode.
- **Manual Entry**: Add items without a barcode (name, category, optional expiration) — handy for produce, the deli counter, or anything that won't scan.
- **LLM Expiration Dates**: Optionally uses a Home Assistant AI Task or Conversation agent (Anthropic/Claude, OpenAI, Google, Ollama — whatever you've set up), or a direct OpenAI / Google Gemini key, to intelligently estimate shelf-life based on the product name and category!
- **Shopping List Sync**: When you click "Consume" on an item, it is automatically added to your native Home Assistant To-do list for your next grocery trip — unless you've marked that product "don't restock" (great for one-off perishables like fresh salmon, or items you won't rebuy).
- **Voice Assistant Ready**: Speak to your Home Assistant to add or consume items!
- **Automations**: Automatically tracks expiring food and emits a `sensor.pantry_expiring_items` entity so you can build HA Automations to notify you when food is going bad.

---

## Step 1: Pre-requisites (Creating a To-Do List)

Before installing the Add-on, we need to create a dedicated To-Do list for your pantry items. In Home Assistant, lists are created via the UI, not by Add-ons.

1. In your Home Assistant sidebar, go to **Settings > Devices & Services**.
2. Click **+ Add Integration** in the bottom right corner.
3. Search for **Local To-do** and select it.
4. Name your list **Pantry** (or anything you prefer).
5. Home Assistant will create a new entity (usually named `todo.pantry`). Remember this entity ID for Step 3!

> **Tip — find the exact entity ID:** Go to **Developer Tools > States** (or **Settings > Devices & Services > Entities**) and type `todo.` in the search box to see the precise ID Home Assistant assigned. The Add-on's default is `todo.shopping_list`, so if your list has any other ID you must enter it in Step 3.

---

## Step 2: Installation

This Add-on must be installed via the Home Assistant Add-on store.

1. Go to **Settings > Add-ons**. *(On Home Assistant 2026.2 and newer this menu is labelled **Settings > Apps**.)*
2. Click the **Add-on Store** button in the bottom right (labelled **App store** on newer versions).
3. Click the three vertical dots (⋮) in the top right corner and select **Repositories**.
4. Paste this repository's URL — `https://github.com/IAmGentrySmith/home-pantry` — and click **Add**.
5. Close the modal and **refresh the page**.
6. Scroll down until you see the new **Home Pantry Add-ons** section, click **Home Pantry**, and click **Install**. *(This might take a few minutes to download and build the container.)*

> **Don't see it after refreshing?** The store only recognises a repository that has a `repository.yaml` at its root with each add-on in its own subfolder (this repo ships that layout). Make sure you pasted the exact HTTPS URL above.

---

## Step 3: Configuration

Before starting the Add-on, click on the **Configuration** tab at the top of the Add-on page.

*   **`todo_list_entity_id`**: Enter the ID of the list you created in Step 1 (e.g., `todo.pantry`).
*   **`llm_provider`**: This powers the automatic expiration date estimation. You can choose:
    *   `none`: Defaults to 14 days (no AI).
    *   `ai_task`: Uses a Home Assistant **AI Task** entity. Works with any LLM you've set up in HA — Anthropic/Claude (e.g. Haiku), OpenAI, Google, Ollama — and no API key is stored in the add-on. *(Recommended.)*
    *   `ha_conversation`: Uses an existing Home Assistant Assist/Conversation agent. Also keeps your key in HA, not here.
    *   `openai` or `gemini`: Calls those services directly; requires providing your own API key below.
*   **`ai_task_entity_id`**: (Optional) For `ai_task`, the specific `ai_task.*` entity to use (**Settings > Voice assistants > AI Task**). Leave blank to use your preferred AI Task entity.
*   **`ha_agent_id`**: (Optional) For `ha_conversation` with multiple agents, the specific Agent ID. Leave blank to use your default HA assistant.
*   **`llm_api_key`**: Your API key (only for `openai` or `gemini`).
*   **`llm_model`**: The model for `openai`/`gemini` (e.g., `gpt-4o-mini` or `gemini-1.5-flash`). Leave blank for a sensible default.
*   **`api_token`**: (Optional) Only needed for the Voice Assistant REST commands in Step 4 — leave blank otherwise. The web UI never needs it, because it is accessed through Home Assistant's authenticated ingress.

Click **Save**, then go back to the **Info** tab and click **Start**. Check the **Show in sidebar** toggle, then click **Open Web UI** (or the new sidebar entry) to access the Pantry UI.

> **Note:** Options are read once at start-up — after changing any setting here, **Restart** the Add-on (Info tab) for it to take effect.
>
> **Camera / scanning:** The first time you tap **Scan**, your browser or the Companion App will ask for camera permission — allow it. The camera only works over a secure connection; opening the UI through Home Assistant (ingress, as above) or the Companion App satisfies this automatically.

### Using a Home Assistant LLM integration (recommended)

The `ai_task` and `ha_conversation` estimators don't store any API key in the Add-on — they reuse an AI model you've already configured in Home Assistant. This works with **Anthropic (Claude)**, OpenAI, Google Generative AI, Ollama, or any integration that provides an AI Task or Conversation entity. Claude is used as the example below; the steps are the same for the others.

**1. Add the AI integration to Home Assistant** *(one time)*
1. Go to **Settings > Devices & Services > + Add Integration**.
2. Search for **Anthropic** (or OpenAI / Google Generative AI / Ollama), select it, and paste your provider API key.
3. When asked for a model, pick a fast, inexpensive one — for Claude, **Haiku** (`claude-haiku-4-5`) is ideal for short shelf-life lookups.

That integration then exposes one or both of:
- an **AI Task** entity (`ai_task.*`) — used by the `ai_task` estimator, and
- a **Conversation** agent (`conversation.*`) — used by the `ha_conversation` estimator.

> Some integrations add these as separate **AI Task** / **Conversation** sub-entries. Click **Configure** on the integration to add the one you want and choose its model.

**2a. Point Home Pantry at it via AI Task** *(recommended)*
1. Find your AI Task entity under **Settings > Voice assistants > AI Task** (or search `ai_task.` in **Developer Tools > States**).
2. In the Add-on **Configuration** tab, set **`llm_provider`** to `ai_task`.
3. *(Optional)* Set **`ai_task_entity_id`** to that entity (e.g. `ai_task.claude`). Leave it blank to use your **preferred** AI Task entity from the same Settings page.
4. **Save**, then **Restart** the Add-on.

**2b. Or point it at a Conversation agent via `ha_conversation`**
Use this if your integration only provides a conversation agent, or you'd rather reuse your existing Assist pipeline.
1. In the Add-on **Configuration** tab, set **`llm_provider`** to `ha_conversation`.
2. *(Optional)* Set **`ha_agent_id`** to a specific conversation entity (e.g. `conversation.claude`, found in **Developer Tools > States**). Leave it blank to use your default Assist agent.
3. **Save**, then **Restart** the Add-on.

> **AI Task vs. `ha_conversation`:** AI Task is purpose-built for "generate a value from a prompt," so it's the better fit for shelf-life estimates. Conversation agents are tuned for chat/voice and may wrap the model with Assist tooling (exposed entities, etc.), which adds latency — reach for `ha_conversation` when that's the only entity your integration exposes, or when you specifically want to reuse your Assist agent.

---

## Step 4: Voice Assistant Integration (Optional)

You can allow your Home Assistant Voice Assistant (like OpenAI ChatGPT or Assist) to directly add or consume items in your pantry!

Because voice assistants usually just give you text (like "Milk") instead of barcodes, the Add-on has special "fuzzy-matching" API endpoints. Reaching them needs two one-time setup steps: unlike the web UI (which goes through the authenticated ingress panel), a `rest_command` calls the Add-on *directly*, so the Add-on's network port must be opened and protected with a token.

**1. Open the port and set an API token**
1. On the Add-on page, open the **Configuration** tab and set **`api_token`** (this acts as the password for the direct API). Need a value? Open the Home Pantry app and click the **key icon** in the top bar to generate a strong token, then paste it here. Click **Save**.
2. Open the **Network** section (the **Network** tab, or the Network panel within the Configuration tab), set the host port for `8099/tcp` to **`8099`**, and click **Save**. *(It ships disabled, so the API is never exposed on your network without a token.)*
3. Go to the **Info** tab and click **Restart** so both changes take effect.

**2. Add REST Commands to Home Assistant**
Open your Home Assistant `configuration.yaml` file and paste the following. Replace `YOUR_API_TOKEN` with the token you just set, and replace `homeassistant.local` with your Home Assistant host name or IP address if `homeassistant.local` doesn't resolve on your network:

```yaml
rest_command:
  pantry_add_item:
    url: "http://homeassistant.local:8099/api/add_by_name"
    method: post
    payload: '{"name": "{{ name }}"}'
    content_type: 'application/json'
    headers:
      Authorization: "Bearer YOUR_API_TOKEN"

  pantry_consume_item:
    url: "http://homeassistant.local:8099/api/consume_by_name"
    method: post
    payload: '{"name": "{{ name }}"}'
    content_type: 'application/json'
    headers:
      Authorization: "Bearer YOUR_API_TOKEN"
```

> **Why not `localhost`?** A `rest_command` runs inside Home Assistant Core, where `localhost` means Core itself — not the Add-on. You must point it at the Home Assistant host's own address (which is where the Add-on's port is published).

*Restart Home Assistant to apply these changes (**Settings > System**, then the power icon in the top-right corner > **Restart Home Assistant**; or **Developer Tools > YAML > Restart**).*

**3. Expose Scripts as Tools**
Next, create two HA Scripts (Settings > Automations & Scripts > Scripts). 
*   Create a script called **"Add to Pantry"** that calls the `rest_command.pantry_add_item` service, passing a variable `name`. 
*   Create another script called **"Consume from Pantry"** that calls `rest_command.pantry_consume_item` with the `name` variable.

If you use the **OpenAI Conversation Integration** (or similar agents that support tools), go to its configuration and expose these two scripts as "Assist Tools". You can now say: *"Hey Assist, we just bought milk, add it to the pantry"* and it will magically appear in the UI!

---

## Step 5: Expiration Notifications (Optional)

The Add-on automatically maintains a sensor in Home Assistant called `sensor.pantry_expiring_items`. The state of this sensor is the **number of items expiring within 7 days**.

> **Note:** This sensor is pushed into Home Assistant via its API, so it is **cleared whenever Home Assistant restarts** and reads `unavailable` until the Add-on refreshes it (within 30 minutes, or immediately if the Add-on itself restarts). A notification automation will not fire during that brief window.

To get notified when food is going bad:

1. Go to **Settings > Automations & Scripts > Automations**.
2. Click **Create Automation**.
3. **Trigger**: Select **Numeric State**, choose `sensor.pantry_expiring_items`, and set **Above: 0**.
4. **Action**: Select **Call Service**, choose `notify.notify` (or your phone specifically).
5. **Message**: `You have {{ states('sensor.pantry_expiring_items') }} items expiring soon in your pantry!`

Save the automation, and you will never let food expire again!

---

## Step 6: Native barcode scanner on a dashboard (optional)

The add-on's built-in scanner uses your browser's camera, which needs a secure (HTTPS) connection — over a local `http://` link (common in the mobile app) the live camera is blocked. The **Home Assistant Companion app has its own native scanner**, but it is only reachable from the main HA frontend, not from inside the add-on's panel (which runs in an ingress iframe). This optional **dashboard card** bridges the gap: it opens the native scanner and sends each barcode straight to Home Pantry. It works **inside the Companion app** (iOS/Android); in a desktop browser the button is disabled (there is no native scanner there).

**Prerequisite — the add-on's direct API (same as Step 4):** set `api_token` (generate one with the **key icon** in the Home Pantry app), publish port `8099/tcp`, and restart the add-on. If you already set up Voice control, you're done.

**1. Add a `rest_command`** to your `configuration.yaml`. The card calls this service, and Home Assistant makes the request to the add-on **server-side**, so there is no browser HTTPS/CORS issue:

```yaml
rest_command:
  pantry_scan:
    url: "http://homeassistant.local:8099/api/scan"
    method: post
    payload: '{"upc": "{{ upc }}"}'
    content_type: 'application/json'
    headers:
      Authorization: "Bearer YOUR_API_TOKEN"
```

Replace `YOUR_API_TOKEN` with your `api_token` (and `homeassistant.local` with your HA host if it doesn't resolve). **Restart Home Assistant** to load it.

**2. Install the card:**
1. Copy [`home_pantry/lovelace/home-pantry-card.js`](home_pantry/lovelace/home-pantry-card.js) from this repo into your Home Assistant config folder under `www/` — i.e. `<config>/www/home-pantry-card.js`. Create the `www` folder if it doesn't exist.
2. Go to **Settings > Dashboards**, open the **⋮** menu (top right) → **Resources** *(enable **Advanced Mode** in your user profile if you don't see it)*, click **+ Add Resource**, set the **URL** to `/local/home-pantry-card.js` and **Resource type** to **JavaScript Module**, then **Create**. Refresh the page.

**3. Add the card** to any dashboard (edit dashboard → **+ Add Card** → search "Home Pantry Scan", or paste YAML):

```yaml
type: custom:home-pantry-scan-card
title: Scan to Pantry
```

A ready-made full view (scan card + expiring sensor + link to the app) is in [`home_pantry/lovelace/pantry-dashboard.yaml`](home_pantry/lovelace/pantry-dashboard.yaml).

**Using it:** open the dashboard in the Companion app and tap **Scan barcode**. The native scanner opens; scan one or more items, then tap **Done**. Each barcode is sent to Home Pantry — products found in Open Food Facts (or already in your pantry) are added automatically. **Unknown barcodes are not auto-added**; open the full **Home Pantry** app from the sidebar and use **+ Add** to enter those by name.

---

## Maintenance & Troubleshooting

**Your data lives on the Add-on's private `/data` volume** (`pantry.sqlite`), which survives Add-on restarts and updates.

- **Backup:** It is included automatically in Home Assistant **Settings > System > Backups**. Take a backup before updating or uninstalling.
- **Update:** When a new version is published, the Add-on page shows an **Update** button; your data is preserved across updates.
- **Uninstall:** Use the **Uninstall** button on the Add-on page. Uninstalling deletes the `/data` volume (and therefore your pantry database), so back up first if you want to keep it.

**Common issues**

- **Shopping list or sensor not updating?** Open the Add-on **Log** tab. These features need a valid `todo_list_entity_id` (Step 3) and the `homeassistant_api` permission (already declared by the Add-on).
- **Every expiration date is 14 days?** That is the fallback used when `llm_provider` is `none`, when an `openai`/`gemini` API key is missing, or when the `ai_task`/`ha_conversation` entity did not respond. Adjust `llm_provider` in Step 3.
- **Scanner won't open?** It needs camera permission and a secure context — open the UI through Home Assistant or the Companion App, not over plain `http://`.
- **Add-on doesn't appear in the store?** See the note under Step 2 (repository layout / exact URL).

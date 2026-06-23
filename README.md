# Home Pantry Add-on

A lightweight, fully local Home Assistant Add-on to manage your kitchen grocery and pantry inventory.

## Features
- **Barcode Scanning**: Built-in HTML5 camera scanner designed perfectly for the iOS/Android Companion Apps.
- **Smart Data Entry**: Automatically queries the Open Food Facts API to identify products based on their UPC barcode.
- **LLM Expiration Dates**: Optionally uses OpenAI, Google Gemini, or Home Assistant's native Conversation Agent to intelligently estimate shelf-life based on the product name and category!
- **Shopping List Sync**: When you click "Consume" on an item, it is automatically added to your native Home Assistant To-do list for your next grocery trip.
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
    *   `none`: Defaults to 14 days.
    *   `openai` or `gemini`: Requires providing your own API key below.
    *   `ha_conversation`: Uses whatever AI agent you already have configured in Home Assistant *(Highly recommended if you already use HA Assist!)*.
*   **`llm_api_key`**: Your API key (only if you selected `openai` or `gemini` above).
*   **`llm_model`**: The model to use (e.g., `gpt-4o-mini` or `gemini-1.5-flash`).
*   **`ha_agent_id`**: (Optional) If you selected `ha_conversation` and have multiple agents, put the specific Agent ID here. Leave blank to use your default HA assistant.
*   **`api_token`**: (Optional) Only needed for the Voice Assistant REST commands in Step 4 — leave blank otherwise. The web UI never needs it, because it is accessed through Home Assistant's authenticated ingress.

Click **Save**, then go back to the **Info** tab and click **Start**. Check the **Show in sidebar** toggle, then click **Open Web UI** (or the new sidebar entry) to access the Pantry UI.

---

## Step 4: Voice Assistant Integration (Optional)

You can allow your Home Assistant Voice Assistant (like OpenAI ChatGPT or Assist) to directly add or consume items in your pantry!

Because voice assistants usually just give you text (like "Milk") instead of barcodes, the Add-on has special "fuzzy-matching" API endpoints. Reaching them needs two one-time setup steps: unlike the web UI (which goes through the authenticated ingress panel), a `rest_command` calls the Add-on *directly*, so the Add-on's network port must be opened and protected with a token.

**1. Open the port and set an API token**
1. On the Add-on page, open the **Configuration** tab and set **`api_token`** to a long random string of your choosing (this acts as the password for the direct API). Click **Save**.
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

*Restart Home Assistant to apply these changes.*

**3. Expose Scripts as Tools**
Next, create two HA Scripts (Settings > Automations & Scripts > Scripts). 
*   Create a script called **"Add to Pantry"** that calls the `rest_command.pantry_add_item` service, passing a variable `name`. 
*   Create another script called **"Consume from Pantry"** that calls `rest_command.pantry_consume_item` with the `name` variable.

If you use the **OpenAI Conversation Integration** (or similar agents that support tools), go to its configuration and expose these two scripts as "Assist Tools". You can now say: *"Hey Assist, we just bought milk, add it to the pantry"* and it will magically appear in the UI!

---

## Step 5: Expiration Notifications (Optional)

The Add-on automatically maintains a sensor in Home Assistant called `sensor.pantry_expiring_items`. The state of this sensor is the **number of items expiring within 7 days**. 

To get notified when food is going bad:

1. Go to **Settings > Automations & Scripts > Automations**.
2. Click **Create Automation**.
3. **Trigger**: Select **Numeric State**, choose `sensor.pantry_expiring_items`, and set **Above: 0**.
4. **Action**: Select **Call Service**, choose `notify.notify` (or your phone specifically).
5. **Message**: `You have {{ states('sensor.pantry_expiring_items') }} items expiring soon in your pantry!`

Save the automation, and you will never let food expire again!

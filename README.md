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

1. Go to **Settings > Add-ons**.
2. Click the **Add-on Store** button in the bottom right.
3. Click the three vertical dots (⋮) in the top right corner and select **Repositories**.
4. Paste the URL of the Git repository hosting this code and click **Add**.
5. Close the modal and **refresh the page**.
6. Scroll down until you see the new repository, click **Home Pantry**, and click **Install**. *(This might take a few minutes to download and build the container).*

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

Click **Save**, then go back to the **Info** tab and click **Start**. Check the **Show in sidebar** toggle so you can easily access the Pantry UI!

---

## Step 4: Voice Assistant Integration (Optional)

You can allow your Home Assistant Voice Assistant (like OpenAI ChatGPT or Assist) to directly add or consume items in your pantry!

Because voice assistants usually just give you text (like "Milk") instead of barcodes, the Add-on has special "fuzzy-matching" API endpoints.

**1. Add REST Commands to Home Assistant**
Open your Home Assistant `configuration.yaml` file and paste the following:

```yaml
rest_command:
  pantry_add_item:
    url: "http://localhost:8099/api/add_by_name"
    method: post
    payload: '{"name": "{{ name }}"}'
    content_type: 'application/json'

  pantry_consume_item:
    url: "http://localhost:8099/api/consume_by_name"
    method: post
    payload: '{"name": "{{ name }}"}'
    content_type: 'application/json'
```

*Restart Home Assistant to apply these changes.*

**2. Expose Scripts as Tools**
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

import axios from 'axios';

export async function lookupUPC(upc) {
  try {
    const url = `https://world.openfoodfacts.org/api/v0/product/${upc}.json`;
    const response = await axios.get(url, { headers: { 'User-Agent': 'HomePantry - HomeAssistant Add-on - 1.0' } });
    if (response.data && response.data.status === 1) {
      const product = response.data.product;
      return {
        upc: upc,
        name: product.product_name || product.generic_name || "Unknown Product",
        category: product.categories ? product.categories.split(',')[0].trim() : "Uncategorized"
      };
    }
  } catch (error) {
    console.error("Open Food Facts API error:", error.message);
  }
  return null;
}

#!/command/with-contenv bashio
set -e

echo "Starting Home Pantry..."

# Create database directory in the persistent /share folder if it doesn't exist
# This ensures the database survives Add-on updates.
if [ ! -d /share/home_pantry ]; then
    echo "Creating persistent directory at /share/home_pantry"
    mkdir -p /share/home_pantry
fi

# Start the Node.js application
cd /app
node server.js

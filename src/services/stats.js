// Shared stats object to avoid circular dependencies
const stats = {
    total_requests: 0,
    successful_requests: 0,
    failed_requests: 0,
    mqtt_messages: 0,
    zabbix_sends: 0,
    connected_clients: 0,
    uptime: "0s",
};

// Default broadcast function
let broadcastFunction = null;

// Set the actual broadcast function when the WebSocket server is initialized
function setBroadcastFunction(broadcastFn) {
    broadcastFunction = broadcastFn;
}

// Broadcast stats using the actual implementation
function broadcastStats() {
    if (broadcastFunction) {
        broadcastFunction(stats);
    } else {
        console.log('Stats broadcast called, but no WebSocket server yet');
    }
}

module.exports = { stats, broadcastStats, setBroadcastFunction };
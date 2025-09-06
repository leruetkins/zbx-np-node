const mqtt = require('mqtt');
const config = require('../config');
const { ZabbixSender, decodeUnicodeEscapeSequences } = require('./zabbixSender');
const { addMessage, sendWebsocketMessage } = require('./websocketServer');
const { stats, broadcastStats } = require('./stats');
const { printTimeDate } = require('./utils'); // Import printTimeDate from utils

let mqttClient = null;
let mqttShutdownSignal = false;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;

// Global MQTT state tracking with comprehensive information
let mqttState = {
    enabled: false,
    status: "unknown",
    url: "",
    topic: "",
    last_updated: new Date().toISOString(),
};

// Broadcast MQTT status change via WebSocket
function broadcastMqttStatus(enabled, status, url, topic) {
    // Update global state with comprehensive information
    mqttState.enabled = enabled;
    mqttState.status = status;
    mqttState.url = url;
    mqttState.topic = topic;
    mqttState.last_updated = new Date().toISOString();
    
    console.log(`DEBUG: Updating MQTT state: enabled=${enabled}, status='${status}', url='${url}'`);

    const statusData = {
        enabled: enabled,
        status: status,
        url: url,
        topic: topic
    };

    sendWebsocketMessage("mqtt_status", statusData);
}

// Send current MQTT status to a specific WebSocket client
function sendCurrentMqttStatusToClient() {
    console.log(`DEBUG: Sending current MQTT state to new client: enabled=${mqttState.enabled}, status='${mqttState.status}', url='${mqttState.url}'`);
    
    const statusData = {
        enabled: mqttState.enabled,
        status: mqttState.status,
        url: mqttState.url,
        topic: mqttState.topic
    };

    sendWebsocketMessage("mqtt_status", statusData);
}

async function mqttConnect() {
    mqttShutdownSignal = false;
    reconnectAttempts = 0;

    const fullConfig = config.getFullConfig();
    const mqttConfig = fullConfig.settings.mqtt;

    const period = (mqttConfig.period || 10) * 1000; // Convert to milliseconds
    let zabbixLastMsg = Date.now() - period - 1000; // Initialize to allow immediate send

    const host = mqttConfig.url;
    const zabbixTopic = mqttConfig.topic;

    if (!host || (!host.startsWith('mqtt://') && !host.startsWith('mqtts://'))) {
        const errorMessage = `MQTT Error: Invalid or missing broker URL: '${host}'. Please ensure it starts with mqtt:// or mqtts://`;
        console.error(errorMessage);
        addMessage(errorMessage, 'error');
        broadcastMqttStatus(true, "error", host, zabbixTopic);
        return; // Prevent further connection attempts
    }

    console.log(`Connecting to MQTT broker: '${host}'`);
    addMessage(`MQTT: Connecting to ${host}`);

    // Update status to connecting now that we're actually attempting connection
    broadcastMqttStatus(true, "connecting", host, zabbixTopic);

    const clientId = `zbx-np-${mqttConfig.id || 'node'}`;
    console.log(`MQTT Client ID: ${clientId}`);

    const url = new URL(host);
    const mqttHost = url.hostname;
    const mqttPort = url.port ? parseInt(url.port, 10) : (url.protocol === 'mqtts:' ? 8883 : 1883);

    const mqttOptions = {
        clientId: clientId,
        keepalive: 30,
        clean: false, // Persistent session
        protocol: url.protocol.replace(':', ''), // 'mqtt' or 'mqtts'
        host: mqttHost,
        port: mqttPort,
        reconnectPeriod: 0, // We'll handle reconnection manually
    };

    if (mqttConfig.login && mqttConfig.login !== "") {
        mqttOptions.username = mqttConfig.login;
        mqttOptions.password = mqttConfig.password;
    }

    if (url.protocol === 'mqtts:') {
        console.log("Enabling TLS for MQTT connection with automatic CA validation");
        addMessage("MQTT: Enabling TLS encryption with system CA certificates");
        // Node.js mqtt client handles TLS automatically with mqtts:// protocol
    }

    mqttClient = mqtt.connect(host, mqttOptions);

    mqttClient.on('connect', () => {
        console.log("MQTT: Connection acknowledged");
        addMessage("MQTT: Client connected and ready", 'mqtt-connect');
        broadcastMqttStatus(true, "running", host, zabbixTopic);
        reconnectAttempts = 0;

        mqttClient.subscribe(zabbixTopic, { qos: 1 }, (err) => {
            if (err) {
                console.error(`Failed to subscribe to MQTT topic ${zabbixTopic}: ${err}`);
                addMessage(`MQTT Error: Failed to subscribe - ${err.message}`, 'error');
                broadcastMqttStatus(true, "error", host, zabbixTopic);
            } else {
                console.log(`Successfully subscribed to MQTT topic: ${zabbixTopic}`);
                addMessage(`MQTT: Subscribed to topic ${zabbixTopic}`, 'mqtt-subscribe');
            }
        });
    });

    mqttClient.on('message', async (topic, message) => {
        if (mqttShutdownSignal) return;

        if (topic === zabbixTopic) {
            const now = Date.now();
            if (now - zabbixLastMsg > period) {
                // Update stats for MQTT message received
                stats.total_requests++; // Increment total requests for MQTT message
                stats.mqtt_messages++;
                broadcastStats();
                
                const timestampMessage = printTimeDate();
                console.log(`\n${timestampMessage}`);
                addMessage(timestampMessage, 'timestamp');

                console.log(`Received MQTT message from topic: ${topic}`);
                console.log(`Payload: ${message.toString()}`);
                addMessage(`MQTT: ${message.toString()}`, 'mqtt-message');

                const payload = message.toString();
                if (payload.trim() === '') {
                    console.log("Received empty MQTT payload, skipping");
                    return;
                }

                try {
                    const data = JSON.parse(payload);

                    // Handle different field names for zabbix_server
                    let zabbixServer = data.zabbix_server;
                    if (!zabbixServer && data.zabbix_server_ip) {
                        const port = data.zabbix_server_port || 10051;
                        zabbixServer = `${data.zabbix_server_ip}:${port}`;
                    }

                    if (!zabbixServer) {
                        console.log("Invalid MQTT payload: missing zabbix_server");
                        addMessage("MQTT Error: Missing zabbix_server field", 'mqtt-error');
                        return;
                    }
                    if (!data.item_host_name) {
                        console.log("Invalid MQTT payload: missing item_host_name");
                        addMessage("MQTT Error: Missing item_host_name field", 'mqtt-error');
                        return;
                    }
                    if (!data.item || data.item.length === 0) {
                        console.log("Invalid MQTT payload: no items specified");
                        addMessage("MQTT Error: No items in payload", 'mqtt-error');
                        return;
                    }

                    const responseJson = {
                        zabbix_server: zabbixServer,
                        item_host_name: data.item_host_name,
                        item: data.item,
                    };

                    try {
                        const result = await sendToZabbixFromMqtt(responseJson);
                        const decodedResult = decodeUnicodeEscapeSequences(result);
                        console.log(`Zabbix result: ${decodedResult}`);
                        addMessage(`Zabbix: ${decodedResult}`, 'mqtt-zabbix-result');
                        // Stats are updated in sendToZabbixFromMqtt function
                        stats.successful_requests++; // Increment successful requests
                        broadcastStats();
                    } catch (e) {
                        console.log(`Error sending to Zabbix: ${e.message}`);
                        addMessage(`Zabbix Error: ${e.message}`, 'error');
                        stats.failed_requests++; // Increment failed requests on Zabbix error
                        broadcastStats();
                    }
                } catch (e) {
                    console.log(`Failed to parse MQTT payload as JSON: ${e.message}`);
                    addMessage(`Parse Error: ${e.message}`, 'mqtt-error');
                }
                zabbixLastMsg = now;
            }
        }
    });

    mqttClient.on('error', async (err) => {
        reconnectAttempts++;
        console.error(`MQTT connection error (attempt ${reconnectAttempts}): ${err.message}`);
        addMessage(`MQTT Error (attempt ${reconnectAttempts}): ${err.message}`, 'mqtt-error');
        
        // Always show disconnected on first error, then reconnecting on subsequent errors
        if (reconnectAttempts === 1) {
            broadcastMqttStatus(true, "disconnected", host, zabbixTopic);
        } else {
            broadcastMqttStatus(true, "reconnecting", host, zabbixTopic);
        }
        
        if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
            console.error("Max reconnection attempts reached. Stopping MQTT client.");
            addMessage("MQTT: Max reconnection attempts reached. Client stopped.", 'mqtt-error');
            broadcastMqttStatus(true, "error", host, zabbixTopic);
            return;
        }
        
        // Exponential backoff for reconnection
        const delaySeconds = Math.min(5 * Math.pow(2, reconnectAttempts - 1), 60);
        console.log(`Attempting to reconnect in ${delaySeconds} seconds...`);
        
        // Show reconnecting status during delay
        if (reconnectAttempts > 1) {
            broadcastMqttStatus(true, "reconnecting", host, zabbixTopic);
        }
        
        // Wait for reconnection delay
        await new Promise(resolve => setTimeout(resolve, delaySeconds * 1000));
        
        // Try to reconnect
        if (!mqttShutdownSignal) {
            mqttClient.reconnect();
        }
    });

    mqttClient.on('close', () => {
        console.log("MQTT client disconnected");
        addMessage("MQTT: Disconnected from broker", 'mqtt-disconnect');
        broadcastMqttStatus(true, "disconnected", host, zabbixTopic);
    });

    mqttClient.on('offline', () => {
        console.log("MQTT client went offline");
        addMessage("MQTT: Client offline", 'mqtt-offline');
        broadcastMqttStatus(true, "offline", host, zabbixTopic);
    });

}

// Restart MQTT service function
async function restartMqttService(enabled) {
    const mqttUrl = config.get('settings.mqtt.url', '');
    const mqttTopic = config.get('settings.mqtt.topic', '');

    // Stop existing MQTT service if running
    mqttDisconnect();

    // Wait a moment for the service to shut down
    await new Promise(resolve => setTimeout(resolve, 500));

    // Start new MQTT service if enabled
    if (enabled) {
        broadcastMqttStatus(true, "starting", mqttUrl, mqttTopic);
        mqttConnect();
        addMessage("MQTT: Service restarted", 'mqtt-status');
    } else {
        addMessage("MQTT: Service disabled", 'mqtt-status');
    }
}

function mqttDisconnect() {
    if (mqttClient) {
        mqttShutdownSignal = true;
        mqttClient.end(true, () => {
            console.log("MQTT client explicitly disconnected.");
            addMessage("MQTT: Service stopped by configuration change", 'mqtt-status');
            broadcastMqttStatus(false, "stopped", mqttState.url, mqttState.topic);
        });
    } else {
        console.log("MQTT client not connected or already disconnected.");
        addMessage("MQTT: Service already stopped or not running.", 'mqtt-status');
        broadcastMqttStatus(false, "stopped", mqttState.url, mqttState.topic);
    }
}

function getMqttStatus() {
    return { ...mqttState }; // Return a copy
}

// Utility function to send data to Zabbix (copied from app.js)
async function sendToZabbixFromMqtt(responseJson) {
    // Parse the zabbix_server field which should be in format "ip:port"
    const serverParts = responseJson.zabbix_server.split(':');
    if (serverParts.length !== 2) {
        throw new Error('Invalid zabbix_server format. Expected "ip:port"');
    }
    
    const zabbixServerIp = serverParts[0];
    const zabbixServerPort = parseInt(serverParts[1], 10);
    const zabbixItemHostName = responseJson.item_host_name;
    const items = responseJson.item;

    const zabbixServerAddr = { address: zabbixServerIp, port: zabbixServerPort };

    const zabbixSender = new ZabbixSender(zabbixServerAddr, zabbixItemHostName);
    for (const item of items) {
        const itemName = item.key;
        let itemValue;
        if (typeof item.value === 'number') {
            itemValue = item.value.toString();
        } else {
            // Handle other types if necessary, or throw an error
            throw new Error(`Invalid value type for item: ${itemName}`);
        }
        zabbixSender.addItem(itemName, itemValue);
    }

    try {
        const showResult = await zabbixSender.send();
        stats.zabbix_sends++; // Increment zabbix_sends on successful send
        // Note: We don't call broadcastStats here because it's called in the message handler
        console.log(`Result = ${showResult}`);
        return showResult;
    } catch (err) {
        // Add the error message to the log here to ensure correct order
        const errorMessage = `Error processing Zabbix request: ${err.message}`;
        console.error(errorMessage);
        addMessage(errorMessage, 'error');
        throw err; // Re-throw the error for the calling function to handle
    }
}

module.exports = {
    mqttConnect,
    mqttDisconnect,
    getMqttStatus,
    broadcastMqttStatus,
    sendCurrentMqttStatusToClient,
    restartMqttService
};
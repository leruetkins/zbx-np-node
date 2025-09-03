const mqtt = require('mqtt');
const config = require('../config');
const { ZabbixSender, decodeUnicodeEscapeSequences } = require('./zabbixSender');
const { addMessage, sendWebsocketMessage } = require('./websocketServer');

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
        addMessage("MQTT: Client connected and ready");
        broadcastMqttStatus(true, "running", host, zabbixTopic);
        reconnectAttempts = 0;

        mqttClient.subscribe(zabbixTopic, { qos: 1 }, (err) => {
            if (err) {
                console.error(`Failed to subscribe to MQTT topic ${zabbixTopic}: ${err}`);
                addMessage(`MQTT Error: Failed to subscribe - ${err.message}`);
                broadcastMqttStatus(true, "error", host, zabbixTopic);
            } else {
                console.log(`Successfully subscribed to MQTT topic: ${zabbixTopic}`);
                addMessage(`MQTT: Subscribed to topic ${zabbixTopic}`);
            }
        });
    });

    mqttClient.on('message', async (topic, message) => {
        if (mqttShutdownSignal) return;

        if (topic === zabbixTopic) {
            const now = Date.now();
            if (now - zabbixLastMsg > period) {
                const timestamp = new Date().toISOString();
                console.log(`\n[${new Date().toLocaleTimeString()} ${new Date().toLocaleDateString()}]`);
                addMessage(`[${new Date().toLocaleTimeString()} ${new Date().toLocaleDateString()}]`);

                console.log(`Received MQTT message from topic: ${topic}`);
                console.log(`Payload: ${message.toString()}`);
                addMessage(`MQTT: ${message.toString()}`);

                const payload = message.toString();
                if (payload.trim() === '') {
                    console.log("Received empty MQTT payload, skipping");
                    return;
                }

                try {
                    const data = JSON.parse(payload);

                    if (!data.zabbix_server) {
                        console.log("Invalid MQTT payload: missing zabbix_server");
                        addMessage("MQTT Error: Missing zabbix_server field");
                        return;
                    }
                    if (!data.item_host_name) {
                        console.log("Invalid MQTT payload: missing item_host_name");
                        addMessage("MQTT Error: Missing item_host_name field");
                        return;
                    }
                    if (!data.item || data.item.length === 0) {
                        console.log("Invalid MQTT payload: no items specified");
                        addMessage("MQTT Error: No items in payload");
                        return;
                    }

                    const responseJson = {
                        zabbix_server: data.zabbix_server,
                        item_host_name: data.item_host_name,
                        item: data.item,
                    };

                    try {
                        const result = await sendToZabbix(responseJson);
                        const decodedResult = decodeUnicodeEscapeSequences(result);
                        console.log(`Zabbix result: ${decodedResult}`);
                        addMessage(`Zabbix: ${decodedResult}`);
                    } catch (e) {
                        console.log(`Error sending to Zabbix: ${e.message}`);
                        addMessage(`Zabbix Error: ${e.message}`);
                    }
                } catch (e) {
                    console.log(`Failed to parse MQTT payload as JSON: ${e.message}`);
                    addMessage(`Parse Error: ${e.message}`);
                }
                zabbixLastMsg = now;
            }
        }
    });

    mqttClient.on('error', async (err) => {
        reconnectAttempts++;
        console.error(`MQTT connection error (attempt ${reconnectAttempts}): ${err.message}`);
        addMessage(`MQTT Error (attempt ${reconnectAttempts}): ${err.message}`);
        
        // Always show disconnected on first error, then reconnecting on subsequent errors
        if (reconnectAttempts === 1) {
            broadcastMqttStatus(true, "disconnected", host, zabbixTopic);
        } else {
            broadcastMqttStatus(true, "reconnecting", host, zabbixTopic);
        }
        
        if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
            console.error("Max reconnection attempts reached. Stopping MQTT client.");
            addMessage("MQTT: Max reconnection attempts reached. Client stopped.");
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
        addMessage("MQTT: Disconnected from broker");
        broadcastMqttStatus(true, "disconnected", host, zabbixTopic);
    });

    mqttClient.on('offline', () => {
        console.log("MQTT client went offline");
        addMessage("MQTT: Client offline");
        broadcastMqttStatus(true, "offline", host, zabbixTopic);
    });
}

function mqttDisconnect() {
    if (mqttClient) {
        mqttShutdownSignal = true;
        mqttClient.end(true, () => {
            console.log("MQTT client explicitly disconnected.");
            addMessage("MQTT: Service stopped by configuration change");
            broadcastMqttStatus(false, "stopped", mqttState.url, mqttState.topic);
        });
    } else {
        console.log("MQTT client not connected or already disconnected.");
        addMessage("MQTT: Service already stopped or not running.");
        broadcastMqttStatus(false, "stopped", mqttState.url, mqttState.topic);
    }
}

function getMqttStatus() {
    return { ...mqttState }; // Return a copy
}

module.exports = {
    mqttConnect,
    mqttDisconnect,
    getMqttStatus,
    broadcastMqttStatus,
    sendCurrentMqttStatusToClient
};
const express = require('express');
const config = require('./config');
const path = require('path');
const { ZabbixSender, decodeUnicodeEscapeSequences } = require('./services/zabbixSender');
const { startWebSocketServer, addMessage, getMessages, sendWebsocketMessage } = require('./services/websocketServer');
const { mqttConnect, mqttDisconnect, getMqttStatus, broadcastMqttStatus, sendCurrentMqttStatusToClient } = require('./services/mqttClient');
const basicAuth = require('express-basic-auth');

const {
    login, logout,
    getConfig, updateConfig, testConfig,
    getStats, getStatsHistory, getRealtimeStats,
    getMqttStatusApi,
    getUsers, createUser, deleteUser,
    getTokens, createToken, deleteToken,
    restartService, getLogs
} = require('./api/auth');

const app = express();

// Middleware
app.use(express.json());
app.use(express.static('public'));

// Stats tracking
let stats = {
    total_requests: 0,
    successful_requests: 0,
    failed_requests: 0,
    mqtt_messages: 0,
    zabbix_sends: 0,
    connected_clients: 0,
    uptime: "0s",
};

// Basic Auth Middleware
const authMiddleware = basicAuth({
    authorizer: (username, password, callback) => {
        const httpLogin = config.get('settings.http.login');
        const httpPassword = config.get('settings.http.password');

        if (username === httpLogin && password === httpPassword) {
            return callback(null, true);
        }
        return callback(null, false);
    },
    authorizeAsync: true,
    unauthorizedResponse: (req) => {
        return req.auth ? 'Credentials rejected' : 'No credentials provided';
    }
});

// Utility function to format timestamp
function printTimeDate() {
    const now = new Date();
    const day = String(now.getDate()).padStart(2, '0');
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const year = now.getFullYear();
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    return `[${hours}:${minutes}:${seconds} ${day}-${month}-${year}]`;
}

// Utility function to send data to Zabbix
async function sendToZabbix(responseData) {
    const zabbixServer = responseData.zabbix_server;
    const [address, port] = zabbixServer.split(':');
    const zabbixServerAddr = { address, port: parseInt(port, 10) };
    const zabbixItemHostName = responseData.item_host_name;
    const items = responseData.item;

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
        console.log(`Result = ${showResult}`);
        addMessage(`Zabbix Result: ${showResult}`);
        return showResult;
    } catch (err) {
        // Add the error message to the log here to ensure correct order
        const errorMessage = `Error processing Zabbix request: ${err.message}`;
        console.error(errorMessage);
        addMessage(errorMessage);
        throw err; // Re-throw the error for the calling function to handle
    }
}

// HTTP GET endpoint for Zabbix data
app.get('/zabbix', authMiddleware, async (req, res) => {
    stats.total_requests++;
    
    const message = printTimeDate();
    console.log(`\n${message}`);
    addMessage(message);

    const remoteAddr = req.ip;
    if (remoteAddr) {
        console.log(`Received data from HTTP via GET: ${remoteAddr}`);
        addMessage(`Received data from HTTP via GET: ${remoteAddr}`);
    } else {
        console.log("Unable to retrieve the remote IP address");
    }

    try {
        const data = JSON.parse(req.query.data);

        const responseJson = {
            zabbix_server: data.zabbix_server,
            item_host_name: data.item_host_name,
            item: data.item,
        };
        console.log(JSON.stringify(responseJson));
        addMessage(JSON.stringify(responseJson));

        const showResult = await sendToZabbix(responseJson);
        const decodedShowResult = decodeUnicodeEscapeSequences(showResult);

        const responseData = {
            data: responseJson,
            result: decodedShowResult
        };

        // Convert the "result" field to a JSON value if it's a string that looks like JSON
        try {
            responseData.result = JSON.parse(responseData.result);
        } catch (e) {
            // If it's not JSON, keep it as a string
        }

        stats.successful_requests++;
        res.json(responseData);
    } catch (err) {
        stats.failed_requests++;
        // Note: We're not adding this to messages here anymore as it's already logged in the ZabbixSender
        res.status(500).json({
            error: "Failed to send data to Zabbix server",
            details: err.message,
        });
    }
});

// HTTP POST endpoint for Zabbix data
app.post('/zabbix', authMiddleware, async (req, res) => {
    stats.total_requests++;
    
    const message = printTimeDate();
    console.log(`\n${message}`);
    addMessage(message);

    const remoteAddr = req.ip;
    if (remoteAddr) {
        console.log(`Received data from HTTP via POST: ${remoteAddr}`);
        addMessage(`Received data from HTTP via POST: ${remoteAddr}`);
    } else {
        console.log("Unable to retrieve the remote IP address");
    }

    try {
        const data = req.body;

        const responseJson = {
            zabbix_server: data.zabbix_server,
            item_host_name: data.item_host_name,
            item: data.item,
        };
        console.log(JSON.stringify(responseJson));
        addMessage(JSON.stringify(responseJson));

        const showResult = await sendToZabbix(responseJson);
        const decodedShowResult = decodeUnicodeEscapeSequences(showResult);

        const responseData = {
            data: responseJson,
            result: decodedShowResult
        };

        // Convert the "result" field to a JSON value if it's a string that looks like JSON
        try {
            responseData.result = JSON.parse(responseData.result);
        } catch (e) {
            // If it's not JSON, keep it as a string
        }

        stats.successful_requests++;
        res.json(responseData);
    } catch (err) {
        stats.failed_requests++;
        // Note: We're not adding this to messages here anymore as it's already logged in the ZabbixSender
        res.status(500).json({
            error: "Failed to send data to Zabbix server",
            details: err.message,
        });
    }
});

// Public endpoints
app.get('/', (req, res) => {
  res.send('<h1>Welcome to zbx-np-node</h1>');
});

app.get('/console', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/admin.html'));
});

app.get('/favicon.ico', (req, res) => {
    // Serve a transparent 1x1 pixel PNG
    const pixel = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVQI12P4//8/AAX+Av7czFnnAAAAAElFTkSuQmCC";
    const decoded = Buffer.from(pixel, 'base64');
    res.writeHead(200, {
        'Content-Type': 'image/png',
        'Content-Length': decoded.length
    });
    res.end(decoded);
});

// Authentication endpoints (no auth required for login)
app.post('/api/auth/login', login);
app.post('/api/auth/logout', logout);

// Configuration API endpoints
app.get('/api/config', getConfig);
app.put('/api/config', updateConfig);
app.post('/api/config/test', testConfig);

// Statistics API endpoints
app.get('/api/stats', getStats);
app.get('/api/stats/history', getStatsHistory);
app.get('/api/stats/realtime', getRealtimeStats);

// MQTT status endpoint
app.get('/api/mqtt/status', getMqttStatusApi);

// User management API endpoints
app.get('/api/users', getUsers);
app.post('/api/users', createUser);
app.delete('/api/users/:id', deleteUser);

// Token management API endpoints
app.get('/api/tokens', getTokens);
app.post('/api/tokens', createToken);
app.delete('/api/tokens/:id', deleteToken);

// Management endpoints
app.post('/api/restart', restartService);
app.get('/api/logs', getLogs);

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
        addMessage("MQTT: Service restarted");
    } else {
        addMessage("MQTT: Service disabled");
    }
}

// Start the server
async function startServer() {
    await config.loadOrCreateConfig();
    const port = config.get('settings.http.port', 7000);

    const server = app.listen(port, () => {
        console.log(`zbx-np-node server running on http://localhost:${port}`);
    });

    // Start WebSocket server
    startWebSocketServer(server);

    // Initialize MQTT state from config immediately
    const mqttEnabled = config.get('settings.mqtt.enabled', false);
    const mqttUrl = config.get('settings.mqtt.url', '');
    const mqttTopic = config.get('settings.mqtt.topic', '');
    
    // Initialize MQTT state immediately to avoid race conditions
    if (mqttEnabled) {
        broadcastMqttStatus(mqttEnabled, "starting", mqttUrl, mqttTopic);
        mqttConnect();
    } else {
        broadcastMqttStatus(mqttEnabled, "disabled", mqttUrl, mqttTopic);
    }
    
    console.log("zbx-np-node server started successfully");
    return port;
}

// Only start server automatically if this file is executed directly (node src/app.js)
if (require.main === module) {
    startServer().catch(err => {
        console.error('Failed to start server:', err);
        process.exit(1);
    });
}

module.exports = { stats, startServer };
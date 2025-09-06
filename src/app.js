const express = require('express');
const config = require('./config');
const path = require('path');
const { ZabbixSender, decodeUnicodeEscapeSequences } = require('./services/zabbixSender');
const { startWebSocketServer, addMessage, getMessages, sendWebsocketMessage, clearAllMessages } = require('./services/websocketServer');
const { mqttConnect, mqttDisconnect, getMqttStatus, broadcastMqttStatus, sendCurrentMqttStatusToClient, restartMqttService } = require('./services/mqttClient');
const { stats, broadcastStats, setBroadcastFunction } = require('./services/stats');
const { printTimeDate } = require('./services/utils'); // Import printTimeDate from utils
const basicAuth = require('express-basic-auth');

const {
    login, logout,
    getConfig, updateConfig, testConfig,
    getStats, getStatsHistory, getRealtimeStats,
    getMqttStatusApi,
    getUsers, createUser, deleteUser,
    getTokens, createToken, deleteToken,
    getLogs
} = require('./api/auth');

const app = express();

// Middleware
app.use(express.json());
app.use(express.static('public'));

// Stats tracking
// Use the shared stats object instead of defining it here
function broadcastStatsWrapper() {
    sendWebsocketMessage('stats', stats);
}

// Set the broadcast function in the shared stats module
setBroadcastFunction((statsData) => {
    sendWebsocketMessage('stats', statsData);
});

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

// Utility function to send data to Zabbix
async function sendToZabbix(zabbixServerIp, zabbixServerPort, zabbixItemHostName, items) {
    const zabbixServerAddr = { address: zabbixServerIp, port: parseInt(zabbixServerPort, 10) };

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
        broadcastStats(); // Broadcast updated stats
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

// HTTP GET endpoint for Zabbix data
app.get('/zabbix', authMiddleware, async (req, res) => {
    stats.total_requests++;
    
    broadcastStats(); // Initial broadcast when total_requests changes
    const message = printTimeDate();
    console.log(`\n${message}`);
    addMessage(message, 'timestamp');

    let remoteAddr = req.ip;
    if (remoteAddr === '::1') {
        remoteAddr = '127.0.0.1';
    }
    if (remoteAddr) {
        console.log(`Received data from HTTP via GET: ${remoteAddr}`);
        addMessage(`Received data from HTTP GET request from: ${remoteAddr}`, 'http-get');
    } else {
        console.log("Unable to retrieve the remote IP address");
    }

    try {
        const { server_ip, server_port, item_host_name, ...otherParams } = req.query;

        const items = [];
        for (const key in otherParams) {
            const parsedValue = parseFloat(otherParams[key]);
            if (!isNaN(parsedValue)) {
                items.push({ key: key, value: parsedValue });
            } else {
                console.warn(`Skipping non-numeric query parameter: ${key}=${otherParams[key]}`);
                addMessage(`Skipping non-numeric query parameter: ${key}=${otherParams[key]}`);
            }
        }

        const responseJson = {
            zabbix_server_ip: server_ip,
            zabbix_server_port: parseInt(server_port, 10),
            item_host_name: item_host_name,
            item: items,
        };
        console.log(JSON.stringify(responseJson));
        addMessage(JSON.stringify(responseJson), 'zabbix-request-payload');

        const showResult = await sendToZabbix(server_ip, server_port, item_host_name, items);
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
        broadcastStats(); // Broadcast after successful request
        res.json(responseData);
    } catch (err) {
        stats.failed_requests++;
        broadcastStats(); // Broadcast after failed request
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
    broadcastStats(); // Initial broadcast when total_requests changes
    const message = printTimeDate();
    console.log(`\n${message}`);
    addMessage(message, 'timestamp');

    let remoteAddr = req.ip;
    if (remoteAddr === '::1') {
        remoteAddr = '127.0.0.1';
    }
    if (remoteAddr) {
        console.log(`Received data from HTTP via POST: ${remoteAddr}`);
        addMessage(`Received data from HTTP POST request from: ${remoteAddr}`, 'http-post');
    } else {
        console.log("Unable to retrieve the remote IP address");
    }

    try {
        const data = req.body;

        const responseJson = {
            zabbix_server_ip: data.zabbix_server_ip,
            zabbix_server_port: data.zabbix_server_port,
            item_host_name: data.item_host_name,
            item: data.item,
        };
        console.log(JSON.stringify(responseJson));
        addMessage(JSON.stringify(responseJson), 'zabbix-request-payload');

        const showResult = await sendToZabbix(responseJson.zabbix_server_ip, responseJson.zabbix_server_port, responseJson.item_host_name, responseJson.item);
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
        broadcastStats(); // Broadcast after successful request
        res.json(responseData);
    } catch (err) {
        stats.failed_requests++;
        broadcastStats(); // Broadcast after failed request
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

// Manual JSON input endpoint (uses session auth like other API endpoints)
app.post('/api/zabbix/manual', async (req, res) => {
    stats.total_requests++;
    broadcastStats(); // Initial broadcast when total_requests changes
    const message = printTimeDate();
    console.log(`\n${message}`);
    addMessage(message, 'timestamp');

    console.log(`Manual JSON Input from Admin Panel`);
    addMessage(`Manual JSON Input from Admin Panel`, 'manual-input-source');

    try {
        const data = req.body;

        const responseJson = {
            zabbix_server_ip: data.zabbix_server_ip,
            zabbix_server_port: data.zabbix_server_port,
            item_host_name: data.item_host_name,
            item: data.item,
        };
        console.log(JSON.stringify(responseJson));
        addMessage(JSON.stringify(responseJson), 'zabbix-request-payload');

        const showResult = await sendToZabbix(responseJson.zabbix_server_ip, responseJson.zabbix_server_port, responseJson.item_host_name, responseJson.item);
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
        broadcastStats(); // Broadcast after successful request
        res.json(responseData);
    } catch (err) {
        stats.failed_requests++;
        broadcastStats(); // Broadcast after failed request
        res.status(500).json({
            error: "Failed to send data to Zabbix server",
            details: err.message,
        });
    }
});

// Management endpoints
app.get('/api/logs', getLogs);

app.post('/api/logs/clear', (req, res) => {
    clearAllMessages();
    res.json({ success: true, message: "Logs cleared" });
});


// Start the server
async function startServer() {
    await config.loadOrCreateConfig();
    const port = config.get('settings.http.port', 7000);

    const server = app.listen(port, () => {
        console.log(`zbx-np-node server running on http://localhost:${port}`);
        // Initial broadcast of stats when server starts
        broadcastStats();
    });

    // Update uptime every second and broadcast stats
    let startTime = process.hrtime();
    setInterval(() => {
        const elapsed = process.hrtime(startTime);
        const seconds = Math.floor(elapsed[0] + elapsed[1] / 1e9);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);
        const remainingSeconds = seconds % 60;
        const remainingMinutes = minutes % 60;

        let uptimeString = '';
        if (hours > 0) uptimeString += `${hours}h `;
        if (minutes > 0) uptimeString += `${remainingMinutes}m `;
        uptimeString += `${remainingSeconds}s`;
        
        stats.uptime = uptimeString.trim();
        broadcastStats();
    }, 1000);

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
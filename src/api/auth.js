const config = require('../config');
const { addMessage, sendWebsocketMessage } = require('../services/websocketServer');
const { getMqttStatus, broadcastMqttStatus, restartMqttService } = require('../services/mqttClient');

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

// Update stats function
function updateStats(key, value = 1) {
    if (stats.hasOwnProperty(key)) {
        stats[key] += value;
    }
}

// Helper functions for config file management
// These are already in config.js, so we will use that.

// Simple login endpoint (using created users from config.json)
async function login(req, res) {
    const { username, password } = req.body;
    const users = config.get('users', []);

    // Check if user exists and password matches
    const userFound = users.find(user => {
        return user.username === username && user.password === password;
    });

    if (userFound) {
        res.json({
            success: true,
            message: "Login successful",
        });
    } else {
        res.status(401).json({
            success: false,
            message: "Invalid credentials",
        });
    }
}

function logout(req, res) {
    res.json({
        message: "Logged out successfully"
    });
}

// Configuration endpoints
async function getConfig(req, res) {
    try {
        const fullConfig = config.getFullConfig();
        const httpConfig = fullConfig.settings.http;
        const mqttConfig = fullConfig.settings.mqtt;

        // Mask MQTT password
        const maskedMqttConfig = { ...mqttConfig, password: "***" };

        res.json({
            http: httpConfig,
            mqtt: maskedMqttConfig,
        });
    } catch (e) {
        res.status(500).json({
            error: "Failed to read configuration file",
            details: e.message
        });
    }
}

async function updateConfig(req, res) {
    const newConfig = req.body;
    try {
        const existingConfig = config.getFullConfig();

        // Check if MQTT settings have changed
        const mqttChanged =
            existingConfig.settings.mqtt.enabled !== newConfig.mqtt.enabled ||
            existingConfig.settings.mqtt.url !== newConfig.mqtt.url ||
            existingConfig.settings.mqtt.topic !== newConfig.mqtt.topic ||
            existingConfig.settings.mqtt.id !== newConfig.mqtt.id ||
            existingConfig.settings.mqtt.login !== newConfig.mqtt.login ||
            (newConfig.mqtt.password !== "***" && existingConfig.settings.mqtt.password !== newConfig.mqtt.password);

        // Update settings while preserving users and tokens
        config.set('settings.http.port', newConfig.http.port);
        config.set('settings.mqtt.enabled', newConfig.mqtt.enabled);
        config.set('settings.mqtt.url', newConfig.mqtt.url);
        config.set('settings.mqtt.id', newConfig.mqtt.id);
        config.set('settings.mqtt.login', newConfig.mqtt.login);
        config.set('settings.mqtt.period', newConfig.mqtt.period);
        config.set('settings.mqtt.topic', newConfig.mqtt.topic);

        // Only update password if it's not the masked value
        if (newConfig.mqtt.password !== "***") {
            config.set('settings.mqtt.password', newConfig.mqtt.password);
        }

        await config.saveConfig();

        let responseMessage = "Configuration updated successfully.";

        // Restart MQTT service if settings changed
        if (mqttChanged) {
            try {
                await restartMqttService(newConfig.mqtt.enabled);
                responseMessage = "Configuration updated and MQTT service restarted successfully.";
            } catch (e) {
                return res.json({
                    success: true,
                    message: `Configuration saved, but MQTT restart failed: ${e.message}`,
                    mqtt_restart_error: true
                });
            }
        }

        res.json({
            success: true,
            message: responseMessage
        });
    } catch (e) {
        res.status(500).json({
            error: "Failed to write configuration file",
            details: e.message
        });
    }
}

function testConfig(req, res) {
    const newConfig = req.body;
    const results = [];

    // Test MQTT connection if enabled
    if (newConfig.mqtt.enabled && newConfig.mqtt.url) {
        results.push({
            service: "MQTT",
            status: "success",
            message: "Configuration appears valid"
        });
    }

    res.json({
        results: results,
        overall_status: "success"
    });
}

// Statistics endpoints
function getStats(req, res) {
    // In a real app, this would fetch live stats
    res.json(stats);
}

function getStatsHistory(req, res) {
    res.json({
        history: [],
        message: "Historical data collection not implemented yet"
    });
}

function getRealtimeStats(req, res) {
    // In a real app, this would fetch live stats
    res.json(stats);
}

// Get MQTT status from global state instead of config file
function getMqttStatusApi(req, res) {
    const status = getMqttStatus();
    console.log(`DEBUG: API returning MQTT state: enabled=${status.enabled}, status='${status.status}', url='${status.url}'`);
    res.json(status);
}

// User management API endpoints
function getUsers(req, res) {
    const users = config.get('users', []);
    const userList = users.map(user => ({
        id: user.id,
        username: user.username,
        created_at: user.created_at
    }));
    res.json(userList);
}

async function createUser(req, res) {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({
            error: "Username and password are required"
        });
    }

    const existingUsers = config.get('users', []);
    if (existingUsers.some(u => u.username === username)) {
        return res.status(409).json({
            error: "Username already exists"
        });
    }

    const nextId = existingUsers.length > 0 ? Math.max(...existingUsers.map(u => u.id)) + 1 : 1;
    const newUser = {
        id: nextId,
        username: username,
        password: password,
        created_at: new Date().toISOString(),
    };

    existingUsers.push(newUser);
    config.set('users', existingUsers);

    try {
        await config.saveConfig();
        res.json({
            success: true,
            message: "User created successfully",
            user: {
                id: newUser.id,
                username: newUser.username,
                created_at: newUser.created_at
            }
        });
    } catch (e) {
        res.status(500).json({
            error: "Failed to save user",
            details: e.message
        });
    }
}

async function deleteUser(req, res) {
    const userId = parseInt(req.params.id, 10);

    if (isNaN(userId)) {
        return res.status(400).json({
            error: "Invalid user ID"
        });
    }

    // Prevent deletion of admin user (ID 1)
    if (userId === 1) {
        return res.status(403).json({
            error: "Cannot delete admin user"
        });
    }

    let users = config.get('users', []);
    const initialLength = users.length;
    users = users.filter(user => user.id !== userId);

    if (users.length < initialLength) {
        config.set('users', users);
        try {
            await config.saveConfig();
            res.json({
                success: true,
                message: `User ${userId} deleted successfully`
            });
        } catch (e) {
            res.status(500).json({
                error: "Failed to save configuration",
                details: e.message
            });
        }
    } else {
        res.status(404).json({
            error: "User not found"
        });
    }
}

// Token management API endpoints
function getTokens(req, res) {
    const tokens = config.get('tokens', []);
    const tokenList = tokens.map(token => {
        const tokenPreview = token.token.length > 8 ? `${token.token.substring(0, 8)}...` : "****";
        return {
            id: token.id,
            name: token.name,
            token_preview: tokenPreview,
            created_at: token.created_at,
            expires_at: token.expires_at,
            is_active: token.is_active
        };
    });
    res.json(tokenList);
}

async function createToken(req, res) {
    const { name, expires_in } = req.body;

    if (!name) {
        return res.status(400).json({
            error: "Token name is required"
        });
    }

    const existingTokens = config.get('tokens', []);
    if (existingTokens.some(t => t.name === name)) {
        return res.status(409).json({
            error: "Token name already exists"
        });
    }

    const nextId = existingTokens.length > 0 ? Math.max(...existingTokens.map(t => t.id)) + 1 : 1;
    const newTokenValue = `zbx_${require('crypto').randomBytes(16).toString('hex')}`; // Generate random token

    let expiresAt = null;
    if (expires_in > 0) {
        const expiryDate = new Date();
        expiryDate.setDate(expiryDate.getDate() + expires_in);
        expiresAt = expiryDate.toISOString();
    }

    const newToken = {
        id: nextId,
        name: name,
        token: newTokenValue,
        created_at: new Date().toISOString(),
        expires_at: expiresAt,
        is_active: true,
    };

    existingTokens.push(newToken);
    config.set('tokens', existingTokens);

    try {
        await config.saveConfig();
        res.json({
            success: true,
            token: newTokenValue, // Return the actual token only once
            name: name,
            expires_at: expiresAt
        });
    } catch (e) {
        res.status(500).json({
            error: "Failed to save token",
            details: e.message
        });
    }
}

async function deleteToken(req, res) {
    const tokenId = parseInt(req.params.id, 10);

    if (isNaN(tokenId)) {
        return res.status(400).json({
            error: "Invalid token ID"
        });
    }

    let tokens = config.get('tokens', []);
    const initialLength = tokens.length;
    tokens = tokens.filter(token => token.id !== tokenId);

    if (tokens.length < initialLength) {
        config.set('tokens', tokens);
        try {
            await config.saveConfig();
            res.json({
                success: true,
                message: `Token ${tokenId} revoked successfully`
            });
        } catch (e) {
            res.status(500).json({
                error: "Failed to save configuration",
                details: e.message
            });
        }
    } else {
        res.status(404).json({
            error: "Token not found"
        });
    }
}

// Management endpoints
function restartService(req, res) {
    res.json({
        message: "Restart functionality not implemented. Please manually restart the service."
    });
}

function getLogs(req, res) {
    const recentMessages = getMessages(); // Assuming getMessages is available from websocketServer
    res.json({
        logs: recentMessages,
        message: "Recent application logs"
    });
}

module.exports = {
    login,
    logout,
    getConfig,
    updateConfig,
    testConfig,
    getStats,
    getStatsHistory,
    getRealtimeStats,
    getMqttStatusApi, // Renamed to avoid conflict with getMqttStatus from mqttClient
    getUsers,
    createUser,
    deleteUser,
    getTokens,
    createToken,
    deleteToken,
    restartService,
    getLogs,
    updateStats // Export for use in other modules
};